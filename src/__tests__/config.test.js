const request = require('supertest');
const app = require('../app');
const { PLANS, machineLimitFor, publicPlans } = require('../config/plans');
const { sellThroughColor, suggestReorder } = require('../config/rules');

beforeAll(() => jest.useRealTimers());
afterAll(() => jest.useFakeTimers());

describe('plans', () => {
  it('unknown tier falls back to the free limit', () => {
    expect(machineLimitFor('nope')).toBe(PLANS.free.machineLimit);
  });
  it('public plans never expose Square plan IDs', () => {
    for (const p of Object.values(publicPlans())) expect(p).not.toHaveProperty('planVariationId');
  });
});

describe('sell-through colour (matches the Snak inventory sheet)', () => {
  // Real rows from the sheet: sold / full capacity → colour
  it.each([
    [21, 40, 'green'],  // Kar's trail mix 0.525
    [8, 15, 'green'],   // Nesquik 0.533
    [5, 24, 'yellow'],  // Powerade Zero 0.208
    [3, 8, 'yellow'],   // Smoothie 0.375
    [7, 36, 'red'],     // Nutri-Grain 0.194
    [4, 24, 'red'],     // Arizona 0.167
  ])('%i / %i → %s', (sold, cap, colour) => {
    expect(sellThroughColor(sold, cap)).toBe(colour);
  });
  it('missing capacity is null, not a divide-by-zero', () => {
    expect(sellThroughColor(5, 0)).toBeNull();
    expect(sellThroughColor(5, null)).toBeNull();
  });
});

describe('reorder suggestion', () => {
  it('stays a multiple of 5 after the performance boost', () => {
    // 30 sold / 30d × 14d = 14 × 1.2 = 16.8 → 20 (old code returned ceil(15×1.2) = 18)
    const n = suggestReorder({ soldInWindow: 30, machinesStocked: 2, machinesPerforming: 2, fallback: 10 });
    expect(n).toBe(20);
    expect(n % 5).toBe(0);
  });
  it('no sales → fallback threshold', () => {
    expect(suggestReorder({ soldInWindow: 0, machinesStocked: 1, machinesPerforming: 0, fallback: 10 })).toBe(10);
  });
});

describe('GET /api/public/config', () => {
  it('serves plans and rules', async () => {
    const res = await request(app).get('/api/public/config').set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(200);
    expect(res.body.data.plans.growth).toEqual({ name: 'Growth', machineLimit: 10, priceCents: 1900, trialDays: 7 });
    expect(res.body.data.rules.sellThrough.greenMin).toBe(0.5);
  });
});
