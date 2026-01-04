const app = require('./app');
const { pool } = require('./config/database');
require('dotenv').config();

const PORT = process.env.PORT || 5000;

// Test database connection before starting server
async function startServer() {
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
