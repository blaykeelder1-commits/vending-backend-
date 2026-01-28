const app = require('./app');
const { pool } = require('./config/database');
const cron = require('node-cron');
const rankingService = require('./services/rankingService');
require('dotenv').config();

const PORT = process.env.PORT || 5000;

let server = null;
let cronRunning = false;

// Validate critical environment variables at startup
function validateEnvironment() {
  const errors = [];

  if (!process.env.JWT_SECRET) {
    errors.push('JWT_SECRET is required');
  } else if (process.env.JWT_SECRET.length < 32) {
    console.warn('⚠ JWT_SECRET should be at least 32 characters for security');
  }

  if (!process.env.DATABASE_URL) {
    console.warn('⚠ DATABASE_URL not set - database features will not work');
  }

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.QR_ENCRYPTION_KEY) {
      console.warn('⚠ QR_ENCRYPTION_KEY not set - using insecure default');
    }
    if (!process.env.FRONTEND_URL) {
      console.warn('⚠ FRONTEND_URL not set - CORS may block requests');
    }
  }

  if (errors.length > 0) {
    console.error('Environment validation failed:');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }
}

// Test database connection before starting server
async function startServer() {
  // Validate environment first
  validateEnvironment();

  let dbConnected = false;

  // Try to connect to database
  try {
    await pool.query('SELECT NOW()');
    console.log('✓ Database connection successful');
    dbConnected = true;
  } catch (error) {
    console.warn('⚠ Database connection failed:', error.message);
    console.warn('⚠ Server will start but database features will not work');
    console.warn('⚠ To fix: Install PostgreSQL or update DATABASE_URL in .env');
  }

  // Start server regardless of database connection
  server = app.listen(PORT, () => {
    console.log(`✓ Server running on port ${PORT}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✓ Health check: http://localhost:${PORT}/api/health`);
    if (!dbConnected) {
      console.log('\n⚠ WARNING: Database not connected. Install PostgreSQL to enable full functionality.');
    }
  });
}

// Hourly maintenance tasks with concurrency guard
cron.schedule('0 * * * *', async () => {
  if (cronRunning) {
    console.log('[Cron] Previous run still active, skipping');
    return;
  }
  cronRunning = true;

  try {
    // Clean up expired sessions
    try {
      const result = await pool.query(
        'DELETE FROM customer_sessions WHERE expires_at < NOW()'
      );
      console.log(`[Cron] Cleaned up ${result.rowCount} expired sessions`);
    } catch (error) {
      console.error('[Cron] Session cleanup error:', error.message);
      if (process.env.SENTRY_DSN) {
        try { require('@sentry/node').captureException(error); } catch (_) {}
      }
    }

    // Recalculate Top 50 product rankings
    try {
      const rankingResult = await rankingService.recalculateAllRankings();
      console.log(`[Cron] Top 50 rankings recalculated: ${rankingResult.productsRanked} products ranked`);
    } catch (error) {
      console.error('[Cron] Ranking recalculation error:', error.message);
      if (process.env.SENTRY_DSN) {
        try { require('@sentry/node').captureException(error); } catch (_) {}
      }
    }
  } finally {
    cronRunning = false;
  }
});

// Graceful shutdown helper
const SHUTDOWN_TIMEOUT = 30000; // 30 seconds

async function gracefulShutdown(signal) {
  console.log(`${signal} received, starting graceful shutdown...`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      console.log('HTTP server closed, no longer accepting connections');
    });
  }

  // Force exit after timeout
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);
  forceExit.unref();

  // Drain DB pool
  try {
    await pool.end();
    console.log('Database pool drained');
  } catch (err) {
    console.error('Error draining database pool:', err.message);
  }

  process.exit(0);
}

// Handle uncaught exceptions — attempt graceful shutdown
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections — attempt graceful shutdown
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  gracefulShutdown('unhandledRejection');
});

// Graceful shutdown on signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();
