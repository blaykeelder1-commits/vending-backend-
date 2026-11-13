// Vendor-facing key management: /api/vendor/api-keys (vendor JWT required).
const express = require('express');
const Joi = require('joi');
const { query } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const { generateKey } = require('../middleware/apiKey');
const logger = require('../utils/logger');

const router = express.Router();
router.use(protect);
router.use(restrictTo('vendor'));

const MAX_ACTIVE_KEYS = 5;

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, key_prefix, scope, created_at, last_used_at, revoked_at
       FROM api_keys WHERE vendor_id = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC`, [req.user.id]);
    res.json({ success: true, data: { keys: r.rows } });
  } catch (e) {
    logger.error('list api keys failed', { error: e.message });
    res.status(500).json({ success: false, message: 'Error loading keys' });
  }
});

router.post('/', async (req, res) => {
  const { error, value } = Joi.object({ name: Joi.string().trim().min(1).max(80).required() }).validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    const active = await query('SELECT COUNT(*)::int AS n FROM api_keys WHERE vendor_id = $1 AND revoked_at IS NULL', [req.user.id]);
    if (active.rows[0].n >= MAX_ACTIVE_KEYS) {
      return res.status(400).json({ success: false, message: `Limit of ${MAX_ACTIVE_KEYS} active keys. Revoke one first.` });
    }
    const { key, prefix, hash } = generateKey();
    const r = await query(
      `INSERT INTO api_keys (vendor_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, name, key_prefix, scope, created_at`, [req.user.id, value.name, prefix, hash]);
    // The only time the full key is ever returned.
    res.status(201).json({ success: true, data: { ...r.rows[0], key } });
  } catch (e) {
    logger.error('create api key failed', { error: e.message });
    res.status(500).json({ success: false, message: 'Error creating key' });
  }
});

router.delete('/:id', async (req, res) => {
  const { error, value } = Joi.object({ id: Joi.number().integer().required() }).validate(req.params);
  if (error) return res.status(400).json({ success: false, message: 'Invalid id' });
  try {
    const r = await query(
      `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND vendor_id = $2 AND revoked_at IS NULL RETURNING id`,
      [value.id, req.user.id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Key not found' });
    res.json({ success: true, message: 'Key revoked' });
  } catch (e) {
    logger.error('revoke api key failed', { error: e.message });
    res.status(500).json({ success: false, message: 'Error revoking key' });
  }
});

module.exports = router;
