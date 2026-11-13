// Stock edit with `remaining`: units sold before a refill must be logged, then the refill.
// DB is mocked — this exercises the route's transaction logic without touching any database.
const jwt = require('jsonwebtoken');

const mockTxnQueries = [];
let mockCurrentStock = 10;
let mockWarehouse = 100;

jest.mock('../config/database', () => {
  const query = jest.fn(async (sql) => {
    if (sql.includes('FROM users WHERE id')) return { rows: [{ id: 7, email: 'v@example.com', full_name: 'V', role: 'vendor' }] };
    if (sql.includes('FROM vending_machines WHERE id')) return { rows: [{ id: 3 }] };
    return { rows: [] };
  });
  const client = {
    query: jest.fn(async (sql, params) => {
      mockTxnQueries.push({ sql, params });
      if (sql.includes('FROM machine_products')) return { rows: [{ id: 1, current_stock: mockCurrentStock, product_id: 42 }] };
      if (sql.includes('FROM vendor_inventory')) return { rows: [{ id: 9, quantity_on_hand: mockWarehouse }] };
      if (sql.includes('UPDATE machine_products')) return { rows: [{ id: 1, current_stock: params[0] }] };
      return { rows: [] };
    }),
  };
  return { pool: { query }, query, transaction: async (fn) => fn(client) };
});
jest.mock('../config/redis', () => {
  const actual = jest.requireActual('../config/redis');
  return { ...actual, cache: { get: async () => null, set: async () => {}, del: async () => {} } };
});

const request = require('supertest');
const app = require('../app');

beforeAll(() => jest.useRealTimers());
afterAll(() => jest.useFakeTimers());
beforeEach(() => { mockTxnQueries.length = 0; mockCurrentStock = 10; });

const token = () => jwt.sign({ id: 7, email: 'v@example.com', role: 'vendor' }, process.env.JWT_SECRET);
const put = (body) => request(app).put('/api/vendor/machines/3/inventory/1')
  .set('Origin', 'http://localhost:3000').set('Authorization', `Bearer ${token()}`).send(body);
const inserts = () => mockTxnQueries.filter(q => q.sql.includes('INSERT INTO inventory_transactions'));

test('refill with remaining logs the sale, then the refill from the counted baseline', async () => {
  const res = await put({ stockQuantity: 12, remaining: 4 });
  expect(res.status).toBe(200);
  const [sold, refill] = inserts();
  expect(sold.sql).toContain("'sold_from_machine'");
  expect(sold.params.slice(2, 5)).toEqual([-6, 10, 4]);        // 10 → 4: 6 sold
  expect(refill.sql).toContain("'dispersal_to_machine'");
  expect(refill.params[2]).toBe(-8);                            // 4 → 12: 8 from mockWarehouse
});

test('refill without remaining keeps old behaviour (no sale logged)', async () => {
  await put({ stockQuantity: 12 });
  const types = inserts().map(q => q.sql.match(/'(\w+)'/)[1]);
  expect(types).toEqual(['dispersal_to_machine']);
});

test('remaining equal to current stock → no sale, refill only', async () => {
  await put({ stockQuantity: 15, remaining: 10 });
  const types = inserts().map(q => q.sql.match(/'(\w+)'/)[1]);
  expect(types).toEqual(['dispersal_to_machine']);
});

test('negative remaining is rejected', async () => {
  const res = await put({ stockQuantity: 12, remaining: -1 });
  expect(res.status).toBe(400);
});
