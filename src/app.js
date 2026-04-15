const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
const requestLogger = require('./middleware/requestLogger');
const { createRateLimitStore, createKeyGenerator } = require('./config/redis');
const logger = require('./utils/logger');
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
  logger.info('Sentry error tracking initialized');
}

const app = express();

// Health check — placed BEFORE all middleware so Render health checks,
// monitoring tools, and keep-alive pings always get through (no Origin needed).
app.get('/api/health', async (req, res) => {
  try {
    const { pool } = require('./config/database');
    const { redis } = require('./config/redis');

    const checks = {
      database: { status: 'unknown' },
      redis: { status: 'unknown' },
      timestamp: new Date().toISOString(),
    };

    let dbFingerprint = null;
    let machinesCount = 0;

    // Check database
    try {
      await pool.query('SELECT 1');
      checks.database.status = 'ok';

      try {
        const dbUrlParsed = new URL(process.env.DATABASE_URL || '');
        const hostParts = dbUrlParsed.hostname.split('.');
        const maskedHost = hostParts.length > 2
          ? `${hostParts[0].substring(0, 3)}***.${hostParts[hostParts.length - 2]}.${hostParts[hostParts.length - 1]}`
          : dbUrlParsed.hostname.substring(0, 10) + '***';
        const dbName = dbUrlParsed.pathname.substring(1) || 'unknown';
        const maskedDb = dbName.length > 4 ? dbName.substring(0, 3) + '***' : '***';
        dbFingerprint = { host: maskedHost, database: maskedDb };
      } catch (_) { /* URL parsing failed, skip fingerprint */ }

      try {
        const countResult = await pool.query('SELECT COUNT(*) as count FROM vending_machines');
        machinesCount = parseInt(countResult.rows[0].count);
      } catch (_) { /* table may not exist yet */ }
    } catch (error) {
      checks.database.status = 'error';
      checks.database.message = error.message;
    }

    // Check Redis if configured
    if (redis) {
      try {
        await redis.ping();
        checks.redis.status = 'ok';
      } catch (error) {
        checks.redis.status = 'error';
        checks.redis.message = error.message;
      }
    } else {
      checks.redis.status = 'not_configured';
    }

    const requiredEnvVars = ['FRONTEND_URL', 'JWT_SECRET', 'DATABASE_URL'];
    const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
    const envStatus = missingEnvVars.length === 0 ? 'ok' : 'missing: ' + missingEnvVars.join(', ');

    const allOk = checks.database.status === 'ok';
    res.status(allOk ? 200 : 503).json({
      status: allOk && missingEnvVars.length === 0 ? 'ok' : 'degraded',
      timestamp: checks.timestamp,
      uptime: process.uptime(),
      database: checks.database,
      database_fingerprint: dbFingerprint,
      redis: checks.redis,
      machines_count: machinesCount,
      environment_variables: envStatus,
      environment: process.env.NODE_ENV || 'development',
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Request logging with correlation IDs
app.use(requestLogger);

// Security middleware with CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", process.env.FRONTEND_URL, "https://accounts.google.com"].filter(Boolean),
      frameSrc: ["'self'", "https://accounts.google.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false, // Required for some image loading scenarios
}));

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      process.env.FRONTEND_URL,
    ].filter(Boolean);

    // Allow requests with no origin (mobile apps, Postman, etc.) - dev only
    if (!origin) {
      if (process.env.NODE_ENV === 'production') {
        return callback(new Error('Origin header required'));
      }
      return callback(null, true);
    }

    // Check if origin matches allowed list or is a Vercel preview URL for this project
    const isAllowed = allowedOrigins.includes(origin) ||
      (origin.endsWith('.vercel.app') && origin.includes('vending-front-end'));

    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn('CORS blocked origin', { origin, allowed: allowedOrigins });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// =============================================================================
// RATE LIMITING CONFIGURATION
// =============================================================================
// Strategy: Per-user limits for authenticated users, per-IP for unauthenticated
// This allows 500+ users behind the same IP (NAT/corporate) to each have full quota

// Rate limit violation logger
const logRateLimitViolation = (req, limiterName) => {
  const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  const userId = req.user?.userId || req.user?.id || 'unauthenticated';
  const path = req.originalUrl || req.path;
  logger.warn('Rate limit exceeded', {
    limiter: limiterName,
    ip,
    userId,
    path,
    method: req.method,
    userAgent: req.headers['user-agent']?.substring(0, 100),
  });
};

// 1. Authenticated API limiter - 5000 req/min per USER (not IP)
// For: /api/vendor/*, /api/analytics/*
const authWindowMs = 60 * 1000;
const authenticatedLimiter = rateLimit({
  windowMs: authWindowMs,
  max: 5000,
  message: { success: false, message: 'Too many requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore(authWindowMs),
  keyGenerator: createKeyGenerator('auth'),
  handler: (req, res, next, options) => {
    logRateLimitViolation(req, 'authenticated');
    res.set('Retry-After', String(Math.ceil(authWindowMs / 1000)));
    res.status(options.statusCode).json(options.message);
  },
});

// 2. Customer API limiter - 2000 req/min per SESSION
// For: /api/customer/*
const customerWindowMs = 60 * 1000;
const customerLimiter = rateLimit({
  windowMs: customerWindowMs,
  max: 2000,
  message: { success: false, message: 'Too many requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore(customerWindowMs),
  keyGenerator: createKeyGenerator('customer'),
  handler: (req, res, next, options) => {
    logRateLimitViolation(req, 'customer');
    res.set('Retry-After', String(Math.ceil(customerWindowMs / 1000)));
    res.status(options.statusCode).json(options.message);
  },
});

// 3. Public endpoints limiter - 1000 req/min per IP (increased for mobile carrier NAT)
// For: /api/stats, /api/health, unauthenticated discovery
const publicWindowMs = 60 * 1000;
const publicLimiter = rateLimit({
  windowMs: publicWindowMs,
  max: 1000,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore(publicWindowMs),
  handler: (req, res, next, options) => {
    logRateLimitViolation(req, 'public');
    res.set('Retry-After', String(Math.ceil(publicWindowMs / 1000)));
    res.status(options.statusCode).json(options.message);
  },
});

// 4. Login limiter - 100 req/min per IP (brute force protection, higher for mobile carrier NAT)
const loginWindowMs = 60 * 1000;
const loginLimiter = rateLimit({
  windowMs: loginWindowMs,
  max: 100,
  message: { success: false, message: 'Too many login attempts, please try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore(loginWindowMs),
  handler: (req, res, next, options) => {
    logRateLimitViolation(req, 'login');
    const retryAfterSecs = Math.ceil(loginWindowMs / 1000);
    res.set('Retry-After', String(retryAfterSecs));
    res.status(options.statusCode).json(options.message);
  },
});

// 5. Registration limiter - 20 req/hour per IP (spam prevention)
const registerWindowMs = 60 * 60 * 1000;
const registerLimiter = rateLimit({
  windowMs: registerWindowMs,
  max: 20,
  message: { success: false, message: 'Too many registration attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore(registerWindowMs),
  handler: (req, res, next, options) => {
    logRateLimitViolation(req, 'register');
    res.set('Retry-After', String(Math.ceil(registerWindowMs / 1000)));
    res.status(options.statusCode).json(options.message);
  },
});

// Request timeout middleware (30 seconds default)
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS) || 30000;
app.use((req, res, next) => {
  res.setTimeout(REQUEST_TIMEOUT, () => {
    if (!res.headersSent) {
      res.status(408).json({ success: false, message: 'Request timeout' });
    }
  });
  next();
});

// Square webhook needs raw body for signature verification — mount BEFORE JSON parser
app.use('/api/subscription/webhook', express.raw({ type: 'application/json' }));

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

// Helper middleware for admin endpoints - inline token verification
const verifyAdminToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'vendor') {
      return res.status(403).json({ success: false, message: 'Vendor access required' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    return res.status(500).json({ success: false, message: 'Authentication error' });
  }
};

// =============================================================================
// APPLY RATE LIMITERS TO ROUTES (must be before route handlers)
// =============================================================================

// Public endpoints - IP-based rate limiting
app.use('/api/health', publicLimiter);
app.use('/api/stats', publicLimiter);
app.use('/api/auth/public', publicLimiter);

// Auth endpoints - strict IP-based rate limiting (brute force / spam protection)
app.use('/api/auth/vendor/login', loginLimiter);
app.use('/api/auth/vendor/register', registerLimiter);
app.use('/api/auth/customer/login', loginLimiter);
app.use('/api/auth/customer/register', registerLimiter);

// Authenticated API routes - user-based rate limiting (each user gets full quota)
app.use('/api/vendor', authenticatedLimiter);
app.use('/api/analytics', authenticatedLimiter);

// Customer routes - session-based rate limiting
app.use('/api/customer', customerLimiter);

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
    logger.error('Error fetching stats', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching statistics',
    });
  }
});

// Admin DB info endpoint (protected)
app.get('/api/admin/db-info', verifyAdminToken, async (req, res) => {
  const { pool } = require('./config/database');

  try {
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
    logger.error('Error fetching DB info', { error: error.message });
    res.status(500).json({ success: false, message: 'Error fetching database info' });
  }
});

// Admin email scheduler endpoint (protected)
app.post('/api/admin/run-email-scheduler', verifyAdminToken, async (req, res) => {
  try {
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
    logger.error('Email scheduler error', { error: error.message });
    res.status(500).json({ success: false, message: 'Error running email scheduler' });
  }
});

// Admin email scheduler stats endpoint (protected)
app.get('/api/admin/email-scheduler-stats', verifyAdminToken, async (req, res) => {
  try {
    const { getSchedulerStats } = require('./services/emailScheduler');
    const stats = await getSchedulerStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Error fetching scheduler stats', { error: error.message });
    res.status(500).json({ success: false, message: 'Error fetching scheduler stats' });
  }
});

// API routes
const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api/public', publicLimiter, require('./routes/public'));
app.use('/api/vendor', require('./routes/vendor'));
app.use('/api/customer', require('./routes/customer'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api', require('./routes/discounts'));
app.use('/api/subscription', authenticatedLimiter, require('./routes/subscription'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

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
