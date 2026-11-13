// /api/v1 read-only API: key auth, GET-only, revocation, vendor scoping. DB is mocked.
const crypto = require('crypto');

const mockKeys = new Map(); // hash -> { id, vendor_id, revoked }
const mockCalls = [];
jest.mock('../config/database', () => {
  const query = jest.fn(async (sql, params = []) => {
    mockCalls.push({ sql, params });
    if (sql.includes('FROM api_keys WHERE key_hash')) {
      const k = mockKeys.get(params[0]);
      return { rows: k && !k.revoked ? [{ id: k.id, vendor_id: k.vendor_id, last_used_at: new Date() }] : [] };
    }
    if (sql.includes('FROM vending_machines')) return { rows: [{ id: 1, machine_name: 'Lobby', location: 'HQ' }] };
    return { rows: [] };
  });
  return { pool: { query }, query, transaction: async (fn) => fn({ query }) };
});

const request = require('supertest');
const app = require('../app');
const { generateKey } = require('../middleware/apiKey');

beforeAll(() => jest.useRealTimers());
afterAll(() => jest.useFakeTimers());

const issue = (vendorId, revoked = false) => {
  const { key, hash } = generateKey();
  mockKeys.set(hash, { id: mockKeys.size + 1, vendor_id: vendorId, revoked });
  return key;
};

test('generated keys are prefixed, random, and only the hash is used for lookup', () => {
  const a = generateKey(); const b = generateKey();
  expect(a.key).toMatch(/^iddi_/);
  expect(a.key).not.toBe(b.key);
  expect(a.hash).toBe(crypto.createHash('sha256').update(a.key).digest('hex'));
});

test('no key → 401 (and no Origin header needed)', async () => {
  const res = await request(app).get('/api/v1/machines');
  expect(res.status).toBe(401);
});

test('valid key → data scoped to the key vendor', async () => {
  const key = issue(42);
  mockCalls.length = 0;
  const res = await request(app).get('/api/v1/machines').set('Authorization', `Bearer ${key}`);
  expect(res.status).toBe(200);
  expect(res.body.data.machines[0].machine_name).toBe('Lobby');
  const machineQuery = mockCalls.find((c) => c.sql.includes('FROM vending_machines'));
  expect(machineQuery.params).toEqual([42]);
});

test('x-api-key header also works', async () => {
  const key = issue(42);
  const res = await request(app).get('/api/v1/').set('x-api-key', key);
  expect(res.status).toBe(200);
  expect(res.body.data.readOnly).toBe(true);
});

test.each(['post', 'put', 'patch', 'delete'])('%s → 405 even with a valid key', async (m) => {
  const key = issue(42);
  const res = await request(app)[m]('/api/v1/machines').set('Authorization', `Bearer ${key}`);
  expect(res.status).toBe(405);
});

test('revoked key → 401', async () => {
  const key = issue(42, true);
  const res = await request(app).get('/api/v1/machines').set('Authorization', `Bearer ${key}`);
  expect(res.status).toBe(401);
});

test('a vendor JWT is not an API key', async () => {
  const jwt = require('jsonwebtoken').sign({ id: 42, role: 'vendor' }, process.env.JWT_SECRET);
  const res = await request(app).get('/api/v1/machines').set('Authorization', `Bearer ${jwt}`);
  expect(res.status).toBe(401);
});

test('ledger validates its query', async () => {
  const key = issue(42);
  const res = await request(app).get('/api/v1/ledger?limit=5000').set('Authorization', `Bearer ${key}`);
  expect(res.status).toBe(400);
});
