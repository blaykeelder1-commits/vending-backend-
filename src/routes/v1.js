// Read-only integration API (/api/v1) for Muse, the Google Sheets mirror, etc.
// Auth: per-vendor API key (middleware/apiKey.js). Every query is scoped to the key's vendor.
// No customer personal data, no writes. Mounted before CORS: server-to-server callers send no Origin.
const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const { query } = require('../config/database');
const { createRateLimitStore } = require('../config/redis');
const { requireApiKey } = require('../middleware/apiKey');
const { RULES } = require('../config/rules');
const { sellThroughSql, buildSellThroughRows } = require('./sheet');
const logger = require('../utils/logger');

const router = express.Router();

const windowMs = 60 * 1000;
const v1Limiter = rateLimit({
  windowMs,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore(windowMs),
  keyGenerator: (req) => `v1:key:${req.apiKey.id}`,
  message: { success: false, message: 'Rate limit: 60 requests/minute per key' },
});

router.use(requireApiKey);
router.use(v1Limiter);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const ok = (res, data) => res.json({ success: true, data });
const fail = (res, err, what) => {
  logger.error(`v1 ${what} failed`, { error: err.message });
  res.status(500).json({ success: false, message: `Error loading ${what}` });
};

router.get('/', (req, res) => ok(res, {
  endpoints: ['/machines', '/inventory', '/ledger?since=YYYY-MM-DD&limit=500', '/sell-through', '/expiring?days=14', '/blacklist'],
  readOnly: true,
}));

router.get('/machines', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, machine_name, location, created_at FROM vending_machines
       WHERE vendor_id = $1 AND is_deleted IS NOT TRUE ORDER BY machine_name`, [req.apiKey.vendorId]);
    ok(res, { machines: r.rows });
  } catch (e) { fail(res, e, 'machines'); }
});

router.get('/inventory', async (req, res) => {
  try {
    const vendorId = req.apiKey.vendorId;
    const [field, warehouse] = await Promise.all([
      query(
        `SELECT vm.id AS machine_id, vm.machine_name, p.id AS product_id, p.product_name, p.sku,
                mp.current_stock, mp.expiration_date, mp.is_performing
         FROM machine_products mp
         JOIN vending_machines vm ON vm.id = mp.machine_id
         JOIN products p ON p.id = mp.product_id
         WHERE vm.vendor_id = $1 AND mp.is_deleted IS NOT TRUE AND vm.is_deleted IS NOT TRUE
         ORDER BY vm.machine_name, p.product_name`, [vendorId]),
      query(
        `SELECT p.id AS product_id, p.product_name, p.sku, vi.quantity_on_hand, vi.reorder_threshold
         FROM vendor_inventory vi JOIN products p ON p.id = vi.product_id
         WHERE vi.vendor_id = $1 AND p.is_deleted IS NOT TRUE ORDER BY p.product_name`, [vendorId]),
    ]);
    ok(res, { inMachines: field.rows, warehouse: warehouse.rows });
  } catch (e) { fail(res, e, 'inventory'); }
});

const ledgerSchema = Joi.object({
  since: Joi.date().iso().optional(),
  limit: Joi.number().integer().min(1).max(1000).default(500),
});

router.get('/ledger', async (req, res) => {
  const { error, value } = ledgerSchema.validate(req.query);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    const r = await query(
      `SELECT t.id, t.created_at, t.transaction_type, t.quantity, t.quantity_before, t.quantity_after,
              p.id AS product_id, p.product_name, p.sku, vm.id AS machine_id, vm.machine_name, t.notes
       FROM inventory_transactions t
       JOIN products p ON p.id = t.product_id
       LEFT JOIN vending_machines vm ON vm.id = t.machine_id
       WHERE t.vendor_id = $1 AND ($2::timestamptz IS NULL OR t.created_at >= $2)
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $3`,
      [req.apiKey.vendorId, value.since || null, value.limit]
    );
    ok(res, { entries: r.rows, count: r.rows.length });
  } catch (e) { fail(res, e, 'ledger'); }
});

router.get('/sell-through', async (req, res) => {
  try {
    const r = await query(sellThroughSql(), [req.apiKey.vendorId]);
    ok(res, { windowDays: RULES.sellThrough.windowDays, rows: buildSellThroughRows(r.rows) });
  } catch (e) { fail(res, e, 'sell-through'); }
});

router.get('/expiring', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || RULES.expiry.listDays, 1), 365);
  try {
    const r = await query(
      `SELECT vm.machine_name, p.product_name, p.sku, mp.current_stock, mp.expiration_date,
              (mp.expiration_date - CURRENT_DATE) AS days_left
       FROM machine_products mp
       JOIN vending_machines vm ON vm.id = mp.machine_id
       JOIN products p ON p.id = mp.product_id
       WHERE vm.vendor_id = $1 AND mp.expiration_date IS NOT NULL AND mp.current_stock > 0
         AND mp.is_deleted IS NOT TRUE AND vm.is_deleted IS NOT TRUE
         AND mp.expiration_date <= CURRENT_DATE + $2::int
       ORDER BY mp.expiration_date`, [req.apiKey.vendorId, days]);
    ok(res, { days, items: r.rows });
  } catch (e) { fail(res, e, 'expiring'); }
});

router.get('/blacklist', async (req, res) => {
  try {
    const r = await query(
      `SELECT product_name, reason, blacklisted_at, (blacklisted_at + $2::int) AS eligible_at
       FROM product_blacklist WHERE vendor_id = $1 AND reintroduced_at IS NULL
       ORDER BY blacklisted_at DESC`, [req.apiKey.vendorId, RULES.blacklistHoldDays]);
    ok(res, { holdDays: RULES.blacklistHoldDays, items: r.rows });
  } catch (e) { fail(res, e, 'blacklist'); }
});

router.use((req, res) => res.status(404).json({ success: false, message: 'Unknown v1 endpoint' }));

module.exports = router;
