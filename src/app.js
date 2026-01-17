const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
require('dotenv').config();

// Initialize Sentry for error tracking (if DSN is provided)
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1, // Sample 10% of transactions for performance monitoring
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
    ],
  });
  console.log('Sentry error tracking initialized');
}

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      process.env.FRONTEND_URL,
    ].filter(Boolean);

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// General rate limiting for all API routes
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { success: false, message: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Strict rate limiting for login endpoints (5 requests per minute)
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { success: false, message: 'Too many login attempts, please try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiting for registration endpoints (3 requests per hour)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { success: false, message: 'Too many registration attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression middleware
app.use(compression());

// Logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Health check endpoint
app.get('/api/health', async (req, res) => {
  const { pool } = require('./config/database');
  const { cache } = require('./config/redis');

  let dbStatus = 'disconnected';
  let redisStatus = cache.isEnabled() ? 'enabled' : 'disabled';
  let dbFingerprint = null;
  let machinesCount = 0;

  try {
    await pool.query('SELECT NOW()');
    dbStatus = 'connected';

    // Get DB fingerprint
    const dbUrlParsed = new URL(process.env.DATABASE_URL || '');
    const hostParts = dbUrlParsed.hostname.split('.');
    const maskedHost = hostParts.length > 2
      ? `${hostParts[0].substring(0, 3)}***.${hostParts[hostParts.length - 2]}.${hostParts[hostParts.length - 1]}`
      : dbUrlParsed.hostname.substring(0, 10) + '***';

    dbFingerprint = {
      host: maskedHost,
      database: dbUrlParsed.pathname.substring(1) || 'unknown'
    };

    // Get machines count
    const countResult = await pool.query('SELECT COUNT(*) as count FROM vending_machines');
    machinesCount = parseInt(countResult.rows[0].count);
  } catch (error) {
    dbStatus = 'error: ' + error.message;
  }

  const requiredEnvVars = [
    'FRONTEND_URL',
    'JWT_SECRET',
    'DATABASE_URL',
  ];

  const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
  const envStatus = missingEnvVars.length === 0 ? 'ok' : 'missing: ' + missingEnvVars.join(', ');

  res.status(200).json({
    status: dbStatus === 'connected' && missingEnvVars.length === 0 ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: dbStatus,
    database_fingerprint: dbFingerprint,
    redis: redisStatus,
    machines_count: machinesCount,
    environment_variables: envStatus,
    environment: process.env.NODE_ENV || 'development',
  });
});

// Public stats endpoint for social proof
app.get('/api/stats', async (req, res) => {
  const { pool } = require('./config/database');
  const { cache } = require('./config/redis');

  try {
    // Check cache first (5 minute TTL)
    const cacheKey = 'public_stats';
    const cachedStats = await cache.get(cacheKey);

    if (cachedStats) {
      // Parse the cached JSON string
      const parsedStats = typeof cachedStats === 'string' ? JSON.parse(cachedStats) : cachedStats;
      return res.json({
        success: true,
        data: parsedStats,
        cached: true,
      });
    }

    // Get public statistics
    const vendorsResult = await pool.query(
      "SELECT COUNT(*) as count FROM users WHERE role = 'vendor'"
    );
    const machinesResult = await pool.query(
      'SELECT COUNT(*) as count FROM vending_machines WHERE is_active = true'
    );
    const productsResult = await pool.query(
      'SELECT COUNT(*) as count FROM machine_products'
    );

    const stats = {
      operators: parseInt(vendorsResult.rows[0].count),
      machines: parseInt(machinesResult.rows[0].count),
      products: parseInt(productsResult.rows[0].count),
      lastUpdated: new Date().toISOString(),
    };

    // Cache the stats (cache.set handles JSON serialization)
    await cache.set(cacheKey, stats, 300);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching statistics',
    });
  }
});

// Rate limiting for public endpoints (more permissive but still protected)
const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to public endpoints
app.use('/api/stats', publicLimiter);
app.use('/api/auth/public', publicLimiter);

// Admin DB info endpoint (protected)
app.get('/api/admin/db-info', async (req, res) => {
  const { pool } = require('./config/database');

  try {
    // Quick inline auth check
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'vendor') {
      return res.status(403).json({ success: false, message: 'Vendor access required' });
    }

    const machinesResult = await pool.query('SELECT COUNT(*) as count FROM vending_machines');
    const vendorsResult = await pool.query('SELECT COUNT(*) as count FROM users WHERE role = $1', ['vendor']);
    const lastMachineResult = await pool.query(
      'SELECT created_at FROM vending_machines ORDER BY created_at DESC LIMIT 1'
    );

    res.json({
      success: true,
      data: {
        machines_count: parseInt(machinesResult.rows[0].count),
        vendors_count: parseInt(vendorsResult.rows[0].count),
        last_machine_created_at: lastMachineResult.rows[0]?.created_at || null,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin email scheduler endpoint (protected)
app.post('/api/admin/run-email-scheduler', async (req, res) => {
  try {
    // Quick inline auth check
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'vendor') {
      return res.status(403).json({ success: false, message: 'Vendor access required' });
    }

    const { runSchedulerTasks, getSchedulerStats } = require('./services/emailScheduler');

    const beforeStats = await getSchedulerStats();
    const results = await runSchedulerTasks();
    const afterStats = await getSchedulerStats();

    res.json({
      success: true,
      data: {
        before: beforeStats,
        results,
        after: afterStats,
      }
    });
  } catch (error) {
    console.error('Email scheduler error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin email scheduler stats endpoint (protected)
app.get('/api/admin/email-scheduler-stats', async (req, res) => {
  try {
    // Quick inline auth check
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'vendor') {
      return res.status(403).json({ success: false, message: 'Vendor access required' });
    }

    const { getSchedulerStats } = require('./services/emailScheduler');
    const stats = await getSchedulerStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API routes with auth-specific rate limiters
const authRouter = require('./routes/auth');

// Apply strict rate limiting to auth endpoints
app.use('/api/auth/vendor/login', loginLimiter);
app.use('/api/auth/vendor/register', registerLimiter);
app.use('/api/auth/customer/login', loginLimiter);
app.use('/api/auth/customer/register', registerLimiter);

app.use('/api/auth', authRouter);
app.use('/api/vendor', require('./routes/vendor'));
app.use('/api/customer', require('./routes/customer'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);

  // Capture error in Sentry if initialized
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err);
  }

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

module.exports = app;
