// sendEmail must report Resend API errors as failures; trial reminders send once and log.
process.env.RESEND_API_KEY = 're_test_dummy';
process.env.RESEND_FROM_EMAIL = 'IDDI <hello@iddisolutions.net>';

const mockSend = jest.fn();
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));

const mockQueries = [];
let mockRows = [];
jest.mock('../config/database', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (sql.includes('FROM users u') && sql.includes('trial_end')) return { rows: mockRows };
    return { rows: [] };
  }),
}));

const { sendEmail } = require('../services/emailService');
const { sendTrialEndingReminders } = require('../services/emailScheduler');

beforeEach(() => { mockSend.mockReset(); mockQueries.length = 0; });

test('Resend error result → success:false (v4 does not throw)', async () => {
  mockSend.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });
  const r = await sendEmail('a@mailbox.org', 'welcome', { userName: 'A' });
  expect(r).toEqual({ success: false, error: 'domain not verified' });
});

test('Resend success → success:true with the real id', async () => {
  mockSend.mockResolvedValue({ data: { id: 'em_123' }, error: null });
  const r = await sendEmail('a@mailbox.org', 'welcome', { userName: 'A' });
  expect(r).toEqual({ success: true, id: 'em_123' });
});

test('trial reminder: sends with plan price, logs sent', async () => {
  mockRows = [{ id: 5, email: 'v@mailbox.org', full_name: 'Vee', subscription_tier: 'growth', trial_end: new Date(Date.now() + 36 * 3600e3) }];
  mockSend.mockResolvedValue({ data: { id: 'em_9' }, error: null });
  const r = await sendTrialEndingReminders();
  expect(r.sent).toBe(1);
  const html = mockSend.mock.calls[0][0].html;
  expect(mockSend.mock.calls[0][0].subject).toMatch(/Growth trial ends (tomorrow|in 2 days)/);
  expect(html).toContain('$19/month');
  expect(html).toContain('Free plan (1 machine)');
  const log = mockQueries.find(q => q.sql.includes('INSERT INTO email_log'));
  expect(log.params.slice(2, 4)).toEqual(['sent', 'em_9']);
});

test('trial reminder: failed send is logged as failed, not counted', async () => {
  mockRows = [{ id: 6, email: 'w@mailbox.org', full_name: null, subscription_tier: 'pro', trial_end: new Date(Date.now() + 20 * 3600e3) }];
  mockSend.mockResolvedValue({ data: null, error: { message: 'bounce' } });
  const r = await sendTrialEndingReminders();
  expect(r.sent).toBe(0);
  expect(r.errors[0].error).toBe('bounce');
  const log = mockQueries.find(q => q.sql.includes('INSERT INTO email_log'));
  expect(log.params[2]).toBe('failed');
});

test.each(['x@iddivendor.com', 'x@vendor.com', 'x@test.com', 'x@example.com', 'nope'])('test address %s is never sent', async (to) => {
  const r = await sendEmail(to, 'welcome', { userName: 'X' });
  expect(r.success).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});
