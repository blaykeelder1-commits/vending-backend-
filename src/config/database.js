const { Pool } = require('pg');
require('dotenv').config();

// PostgreSQL connection pool
// Note: ssl.rejectUnauthorized: false is needed for some cloud providers (Render, Heroku)
// For production with proper SSL certs, set DATABASE_SSL_REJECT_UNAUTHORIZED=true
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true'
  } : false,
  max: parseInt(process.env.DATABASE_POOL_MAX) || 20, // Default pool size (adjustable via env)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
});

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
  // Don't exit - let the pool recover or individual queries fail gracefully
  // The pool will automatically attempt to reconnect on next query
});

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
      console.log('Executed query', { text: truncatedText, duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    // Log error without sensitive parameter data
    console.error('Database query error:', {
      error: error.message,
      code: error.code,
      query: text.substring(0, 100)
    });
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
