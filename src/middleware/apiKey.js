// Read-only API key auth for /api/v1. Keys are vendor-bound, hashed at rest, revocable.
const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const KEY_PREFIX = 'iddi_';
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

function generateKey() {
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

function extractKey(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ' + KEY_PREFIX)) return h.slice(7).trim();
  const x = req.headers['x-api-key'];
  return typeof x === 'string' && x.startsWith(KEY_PREFIX) ? x.trim() : null;
}

async function requireApiKey(req, res, next) {
  // Read-only by construction: anything but GET/HEAD is refused before auth.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.set('Allow', 'GET');
    return res.status(405).json({ success: false, message: 'Read-only API: GET only' });
  }
  const key = extractKey(req);
  if (!key) return res.status(401).json({ success: false, message: 'API key required' });
  try {
    const result = await query(
      `SELECT id, vendor_id, last_used_at FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hashKey(key)]
    );
    if (result.rows.length === 0) return res.status(401).json({ success: false, message: 'Invalid or revoked API key' });
    const row = result.rows[0];
    req.apiKey = { id: row.id, vendorId: row.vendor_id };
    // Touch last_used_at at most once a minute (cheap audit without a write per call)
    if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
      query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id])
        .catch((e) => logger.warn('api key touch failed', { error: e.message }));
    }
    logger.info('api v1 call', { keyId: row.id, vendorId: row.vendor_id, path: req.path });
    return next();
  } catch (error) {
    logger.error('API key auth error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Authentication error' });
  }
}

module.exports = { requireApiKey, generateKey, hashKey, KEY_PREFIX };
