const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

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

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

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

  let dbStatus = 'disconnected';
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
    machines_count: machinesCount,
    environment_variables: envStatus,
    environment: process.env.NODE_ENV || 'development',
  });
});

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

// API routes
app.use('/api/auth', require('./routes/auth'));
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

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

module.exports = app;
