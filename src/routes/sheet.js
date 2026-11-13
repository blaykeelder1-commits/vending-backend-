// Sheet parity: the views the Snak inventory sheet kept by hand, computed from the ledger.
// Mounted at /api/vendor/sheet (vendor-only, authenticatedLimiter via the /api/vendor prefix).
const express = require('express');
const Joi = require('joi');
const { query } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const { RULES, sellThroughColor } = require('../config/rules');
const logger = require('../utils/logger');

const router = express.Router();
router.use(protect);
router.use(restrictTo('vendor'));

const WEEKS = Math.ceil(RULES.sellThrough.windowDays / 7);

/**
 * Pure: build sell-through rows from DB rows. Exported for tests.
 * weekly[0] is the most recent 7 days.
 */
function buildSellThroughRows(rows) {
  return rows.map((r) => {
    const weekly = Array.from({ length: WEEKS }, (_, i) => Number(r[`w${i}`]) || 0);
    const sold = weekly.reduce((a, b) => a + b, 0);
    const capacity = r.full_capacity == null ? null : Number(r.full_capacity);
    const price = r.price == null ? null : Number(r.price);
    const unitCost = r.unit_cost == null ? null : Number(r.unit_cost);
    return {
      productId: r.id,
      sku: r.sku,
      productName: r.product_name,
      weekly,
      sold,
      capacity,
      sellThrough: capacity ? Math.round((sold / capacity) * 1000) / 1000 : null,
      color: sellThroughColor(sold, capacity),
      inMachines: Number(r.in_machines) || 0,
      inWarehouse: Number(r.in_warehouse) || 0,
      price,
      unitCost,
      supplier: r.supplier,
      marginEach: price != null && unitCost != null ? Math.round((price - unitCost) * 100) / 100 : null,
      blacklisted: r.blacklisted === true,
    };
  });
}

/** SQL for the sell-through view ($1 = vendor id). Exported so it can be dry-run. */
function sellThroughSql() {
    const weekCols = Array.from({ length: WEEKS }, (_, i) =>
      `SUM(CASE WHEN t.created_at >= NOW() - INTERVAL '1 day' * ${(i + 1) * 7}
                 AND t.created_at <  NOW() - INTERVAL '1 day' * ${i * 7}
            THEN ABS(t.quantity) ELSE 0 END) AS w${i}`
    ).join(',\n');

  return `WITH sales AS (
         SELECT t.product_id, ${weekCols}
         FROM inventory_transactions t
         WHERE t.vendor_id = $1 AND t.transaction_type = 'sold_from_machine'
           AND t.created_at >= NOW() - INTERVAL '1 day' * ${WEEKS * 7}
         GROUP BY t.product_id
       ),
       field AS (
         SELECT mp.product_id, SUM(mp.current_stock) AS in_machines
         FROM machine_products mp JOIN vending_machines vm ON vm.id = mp.machine_id
         WHERE vm.vendor_id = $1 AND mp.is_deleted IS NOT TRUE AND vm.is_deleted IS NOT TRUE
         GROUP BY mp.product_id
       )
       SELECT p.id, p.sku, p.product_name, p.price, p.unit_cost, p.supplier, p.full_capacity,
              ${Array.from({ length: WEEKS }, (_, i) => `COALESCE(s.w${i}, 0) AS w${i}`).join(', ')},
              COALESCE(f.in_machines, 0) AS in_machines,
              COALESCE(vi.quantity_on_hand, 0) AS in_warehouse,
              EXISTS (SELECT 1 FROM product_blacklist b
                      WHERE b.vendor_id = $1 AND b.reintroduced_at IS NULL
                        AND (b.product_id = p.id OR lower(b.product_name) = lower(p.product_name))) AS blacklisted
       FROM products p
       LEFT JOIN sales s ON s.product_id = p.id
       LEFT JOIN field f ON f.product_id = p.id
       LEFT JOIN vendor_inventory vi ON vi.product_id = p.id AND vi.vendor_id = $1
       WHERE p.vendor_id = $1 AND p.is_deleted IS NOT TRUE
       ORDER BY p.product_name`;
}

// GET /api/vendor/sheet/sell-through — one row per product, like the sheet's sales tab
router.get('/sell-through', async (req, res) => {
  try {
    const result = await query(
      sellThroughSql(),
      [req.user.id]
    );

    const rows = buildSellThroughRows(result.rows);
    const count = (c) => rows.filter((r) => r.color === c).length;
    res.json({
      success: true,
      data: {
        windowDays: WEEKS * 7,
        bands: { greenMin: RULES.sellThrough.greenMin, yellowMin: RULES.sellThrough.yellowMin },
        summary: {
          green: count('green'), yellow: count('yellow'), red: count('red'),
          noCapacity: rows.filter((r) => r.capacity == null).length,
        },
        rows,
      },
    });
  } catch (error) {
    logger.error('Error building sell-through', { error: error.message });
    res.status(500).json({ success: false, message: 'Error building sell-through' });
  }
});

// GET /api/vendor/sheet/blacklist — pulled products with re-intro countdown
router.get('/blacklist', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, product_id, product_name, reason, sold_in_window, blacklisted_at, reintroduced_at,
              (blacklisted_at + $2::int) AS eligible_at,
              (CURRENT_DATE >= blacklisted_at + $2::int) AS eligible
       FROM product_blacklist
       WHERE vendor_id = $1
       ORDER BY reintroduced_at IS NOT NULL, blacklisted_at DESC`,
      [req.user.id, RULES.blacklistHoldDays]
    );
    res.json({ success: true, data: { holdDays: RULES.blacklistHoldDays, items: result.rows } });
  } catch (error) {
    logger.error('Error loading blacklist', { error: error.message });
    res.status(500).json({ success: false, message: 'Error loading blacklist' });
  }
});

const blacklistSchema = Joi.object({
  productId: Joi.number().integer().optional(),
  productName: Joi.string().min(1).max(255).optional(),
  reason: Joi.string().max(500).allow('').optional(),
  soldInWindow: Joi.number().integer().min(0).optional(),
}).or('productId', 'productName');

// POST /api/vendor/sheet/blacklist — pull a product
router.post('/blacklist', async (req, res) => {
  const { error, value } = blacklistSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    let { productId, productName } = value;
    if (productId) {
      const p = await query('SELECT product_name FROM products WHERE id = $1 AND vendor_id = $2', [productId, req.user.id]);
      if (p.rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });
      productName = p.rows[0].product_name;
    }
    const result = await query(
      `INSERT INTO product_blacklist (vendor_id, product_id, product_name, reason, sold_in_window)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vendor_id, lower(product_name)) WHERE reintroduced_at IS NULL DO NOTHING
       RETURNING *`,
      [req.user.id, productId || null, productName, value.reason || null, value.soldInWindow ?? null]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ success: false, message: 'Already on the blacklist' });
    }
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    logger.error('Error adding to blacklist', { error: err.message });
    res.status(500).json({ success: false, message: 'Error adding to blacklist' });
  }
});

// POST /api/vendor/sheet/blacklist/:id/reintroduce
router.post('/blacklist/:id/reintroduce', async (req, res) => {
  const { error, value } = Joi.object({ id: Joi.number().integer().required() }).validate(req.params);
  if (error) return res.status(400).json({ success: false, message: 'Invalid id' });
  try {
    const result = await query(
      `UPDATE product_blacklist SET reintroduced_at = CURRENT_DATE
       WHERE id = $1 AND vendor_id = $2 AND reintroduced_at IS NULL RETURNING *`,
      [value.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    logger.error('Error reintroducing product', { error: err.message });
    res.status(500).json({ success: false, message: 'Error reintroducing product' });
  }
});

module.exports = router;
module.exports.buildSellThroughRows = buildSellThroughRows;
module.exports.sellThroughSql = sellThroughSql;
