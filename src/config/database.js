const { Pool } = require('pg');
require('dotenv').config();
const logger = require('../utils/logger');

// PostgreSQL connection pool
// Note: ssl.rejectUnauthorized: false is needed for some cloud providers (Render, Heroku)
// For production with proper SSL certs, set DATABASE_SSL_REJECT_UNAUTHORIZED=true
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true'
  } : false,
  max: parseInt(process.env.DATABASE_POOL_MAX) || 40, // Default pool size for 500+ users
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
  statement_timeout: parseInt(process.env.DATABASE_STATEMENT_TIMEOUT) || 30000, // 30s query timeout
});

// Test database connection
pool.on('connect', () => {
  logger.info('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  // Log error without potentially sensitive connection details
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message });
  // Don't exit - let the pool recover or individual queries fail gracefully
  // The pool will automatically attempt to reconnect on next query
});

// Log pool exhaustion warnings
setInterval(() => {
  const { totalCount, idleCount, waitingCount } = pool;
  if (waitingCount > 0) {
    logger.warn('DB Pool connections waiting', { waiting: waitingCount, active: totalCount - idleCount, idle: idleCount, total: totalCount });
  }
}, 10000);

// Query helper function
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    // Only log queries in development or if they're slow (>1000ms)
    if (process.env.NODE_ENV === 'development' || duration > 1000) {
      // Truncate query text to avoid logging sensitive data
      const truncatedText = text.length > 100 ? text.substring(0, 100) + '...' : text;
      logger.debug('Executed query', { text: truncatedText, duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    // Log error without sensitive parameter data
    logger.error('Database query error', { error: error.message, code: error.code, query: text.substring(0, 100) });
    throw error;
  }
};

// Transaction helper
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  query,
  transaction,
};
