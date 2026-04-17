const app = require('./app');
const { pool } = require('./config/database');
const cron = require('node-cron');
const rankingService = require('./services/rankingService');
const analyticsAggregator = require('./services/analyticsAggregator');
const analyticsService = require('./services/analyticsService');
const logger = require('./utils/logger');
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
    logger.warn('JWT_SECRET should be at least 32 characters for security');
  }

  if (!process.env.DATABASE_URL) {
    logger.warn('DATABASE_URL not set - database features will not work');
  }

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.QR_ENCRYPTION_KEY) {
      logger.warn('QR_ENCRYPTION_KEY not set - using insecure default');
    }
    if (!process.env.FRONTEND_URL) {
      logger.warn('FRONTEND_URL not set - CORS may block requests');
    }
  }

  if (errors.length > 0) {
    logger.error('Environment validation failed', { errors });
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
    logger.info('Database connection successful');
    dbConnected = true;
  } catch (error) {
    logger.warn('Database connection failed', { error: error.message });
    logger.warn('Server will start but database features will not work');
  }

  // Start server regardless of database connection
  server = app.listen(PORT, () => {
    logger.info('Server started', {
      port: PORT,
      environment: process.env.NODE_ENV || 'development',
      healthCheck: `http://localhost:${PORT}/api/health`,
      dbConnected
    });
  });

  // Warm Google JWKS cache so the first real verifyIdToken isn't cold.
  if (process.env.GOOGLE_CLIENT_ID) {
    try {
      const { OAuth2Client } = require('google-auth-library');
      const warm = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      warm.getFederatedSignonCertsAsync().catch(() => {});
    } catch (_) { /* ignore */ }
  }
}

// Hourly maintenance tasks with concurrency guard
cron.schedule('0 * * * *', async () => {
  if (cronRunning) {
    logger.debug('Cron: Previous run still active, skipping');
    return;
  }
  cronRunning = true;

  try {
    // Clean up expired sessions
    try {
      const result = await pool.query(
        'DELETE FROM customer_sessions WHERE expires_at < NOW()'
      );
      logger.info('Cron: Session cleanup complete', { expiredSessions: result.rowCount });
    } catch (error) {
      logger.error('Cron: Session cleanup error', { error: error.message });
      if (process.env.SENTRY_DSN) {
        try { require('@sentry/node').captureException(error); } catch (_) {}
      }
    }

    // Recalculate Top 50 product rankings
    try {
      const rankingResult = await rankingService.recalculateAllRankings();
      logger.info('Cron: Rankings recalculated', { productsRanked: rankingResult.productsRanked });
    } catch (error) {
      logger.error('Cron: Ranking recalculation error', { error: error.message });
      if (process.env.SENTRY_DSN) {
        try { require('@sentry/node').captureException(error); } catch (_) {}
      }
    }

    // Flush analytics event buffer
    try {
      await analyticsService.flushEventBuffer();
    } catch (error) {
      logger.error('Cron: Analytics buffer flush error', { error: error.message });
    }

    // Aggregate hourly analytics
    try {
      const hourlyResult = await analyticsAggregator.aggregateHourlyAnalytics();
      logger.info('Cron: Hourly analytics aggregated', { records: hourlyResult.aggregatedRecords });
    } catch (error) {
      logger.error('Cron: Hourly analytics aggregation error', { error: error.message });
      if (process.env.SENTRY_DSN) {
        try { require('@sentry/node').captureException(error); } catch (_) {}
      }
    }
  } finally {
    cronRunning = false;
  }
});

// Daily analytics aggregation (runs at midnight)
cron.schedule('0 0 * * *', async () => {
  logger.info('Cron: Running daily analytics aggregation');
  try {
    const dailyResult = await analyticsAggregator.aggregateDailyAnalytics();
    logger.info('Cron: Daily analytics aggregated', {
      records: dailyResult.aggregatedRecords,
      date: dailyResult.dateProcessed
    });

    // Clean up old analytics events (keep 90 days)
    const cleanupResult = await analyticsAggregator.cleanupOldEvents();
    logger.info('Cron: Old analytics events cleaned up', { deletedEvents: cleanupResult.deletedEvents });

    // Send spoilage alerts
    try {
      const { scheduleSpoilageAlerts } = require('./services/emailScheduler');
      const spoilageResult = await scheduleSpoilageAlerts();
      logger.info('Cron: Spoilage alerts sent', spoilageResult);
    } catch (error) {
      logger.error('Cron: Spoilage alert error', { error: error.message });
    }
  } catch (error) {
    logger.error('Cron: Daily analytics aggregation error', { error: error.message });
    if (process.env.SENTRY_DSN) {
      try { require('@sentry/node').captureException(error); } catch (_) {}
    }
  }
});

// Weekly vendor analytics aggregation (runs every Monday at 1 AM)
cron.schedule('0 1 * * 1', async () => {
  logger.info('Cron: Running weekly vendor analytics aggregation');
  try {
    const weeklyResult = await analyticsAggregator.aggregateWeeklyVendorAnalytics();
    logger.info('Cron: Weekly vendor analytics aggregated', {
      vendors: weeklyResult.aggregatedVendors,
      week: weeklyResult.weekProcessed
    });
  } catch (error) {
    logger.error('Cron: Weekly analytics aggregation error', { error: error.message });
    if (process.env.SENTRY_DSN) {
      try { require('@sentry/node').captureException(error); } catch (_) {}
    }
  }
});

// Graceful shutdown helper
const SHUTDOWN_TIMEOUT = 30000; // 30 seconds

async function gracefulShutdown(signal) {
  logger.info('Graceful shutdown initiated', { signal });

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
    });
  }

  // Force exit after timeout
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);
  forceExit.unref();

  // Drain DB pool
  try {
    await pool.end();
    logger.info('Database pool drained');
  } catch (err) {
    logger.error('Error draining database pool', { error: err.message });
  }

  process.exit(0);
}

// Handle uncaught exceptions — attempt graceful shutdown
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections — attempt graceful shutdown
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Rejection', { error: err?.message, stack: err?.stack });
  gracefulShutdown('unhandledRejection');
});

// Graceful shutdown on signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();
