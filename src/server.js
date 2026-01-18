const app = require('./app');
const { pool } = require('./config/database');
const cron = require('node-cron');
require('dotenv').config();

const PORT = process.env.PORT || 5000;

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
  app.listen(PORT, () => {
    console.log(`✓ Server running on port ${PORT}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✓ Health check: http://localhost:${PORT}/api/health`);
    if (!dbConnected) {
      console.log('\n⚠ WARNING: Database not connected. Install PostgreSQL to enable full functionality.');
    }
  });
}

// Clean up expired sessions every hour
cron.schedule('0 * * * *', async () => {
  try {
    const result = await pool.query(
      'DELETE FROM customer_sessions WHERE expires_at < NOW()'
    );
    console.log(`[Cron] Cleaned up ${result.rowCount} expired sessions`);
  } catch (error) {
    console.error('[Cron] Session cleanup error:', error.message);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing server gracefully...');
  await pool.end();
  process.exit(0);
});

startServer();
