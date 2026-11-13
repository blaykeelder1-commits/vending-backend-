const request = require('supertest');
const app = require('../app');
const { buildSellThroughRows } = require('../routes/sheet');

beforeAll(() => jest.useRealTimers());
afterAll(() => jest.useFakeTimers());

const row = (o) => ({ id: 1, sku: null, product_name: 'X', price: '2.50', unit_cost: '1.02', supplier: null,
  full_capacity: 40, w0: 5, w1: 4, w2: 3, w3: 9, w4: 0, in_machines: 10, in_warehouse: 3, blacklisted: false, ...o });

describe('buildSellThroughRows', () => {
  it('sums 5 weekly columns (fixes the sheet total that only matched some rows)', () => {
    const [r] = buildSellThroughRows([row({})]);
    expect(r.weekly).toEqual([5, 4, 3, 9, 0]);
    expect(r.sold).toBe(21);
    expect(r.color).toBe('green'); // 21/40 = 0.525, Kar's row in the sheet
    expect(r.marginEach).toBe(1.48);
  });
  it('no capacity → null colour instead of #DIV/0!', () => {
    const [r] = buildSellThroughRows([row({ full_capacity: null })]);
    expect(r.color).toBeNull();
    expect(r.sellThrough).toBeNull();
  });
  it('missing cost → null margin', () => {
    const [r] = buildSellThroughRows([row({ unit_cost: null })]);
    expect(r.marginEach).toBeNull();
  });
});

describe('sheet routes require a vendor login', () => {
  it.each(['/api/vendor/sheet/sell-through', '/api/vendor/sheet/blacklist'])('%s → 401 without token', async (path) => {
    const res = await request(app).get(path).set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(401);
  });
});
