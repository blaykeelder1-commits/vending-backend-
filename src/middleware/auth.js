const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

// Verify JWT token for vendor authentication
const verifyToken = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if user exists and is a vendor
    const result = await query(
      'SELECT id, email, role FROM users WHERE id = $1 AND role = $2',
      [decoded.id, 'vendor']
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token or user not found.',
      });
    }

    // Attach user to request
    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token.',
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired.',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Error verifying token.',
    });
  }
};

// Verify customer session (QR-based authentication)
const verifyCustomerSession = async (req, res, next) => {
  try {
    // Get session token from header
    const authHeader = req.headers['authorization'];
    const sessionToken = authHeader && authHeader.split(' ')[1];

    if (!sessionToken) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No session token provided.',
      });
    }

    // Check if session exists and is valid
    const result = await query(
      `SELECT cs.id, cs.customer_id, cs.machine_id, cs.expires_at, u.email, u.role
       FROM customer_sessions cs
       LEFT JOIN users u ON cs.customer_id = u.id
       WHERE cs.session_token = $1 AND cs.expires_at > NOW()`,
      [sessionToken]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired session.',
      });
    }

    const session = result.rows[0];

    // Attach session and user info to request
    req.session = {
      id: session.id,
      customerId: session.customer_id,
      machineId: session.machine_id,
    };

    if (session.customer_id) {
      req.user = {
        id: session.customer_id,
        email: session.email,
        role: session.role,
      };
    }

    next();
  } catch (error) {
    console.error('Session verification error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error verifying session.',
    });
  }
};

// Role-based authorization middleware
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated.',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access forbidden. Insufficient permissions.',
      });
    }

    next();
  };
};

// Generic authentication middleware (handles both JWT and session)
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    // Try JWT first (vendor)
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const result = await query(
        'SELECT id, email, full_name, role FROM users WHERE id = $1',
        [decoded.id]
      );

      if (result.rows.length > 0) {
        req.user = {
          id: result.rows[0].id,
          email: result.rows[0].email,
          fullName: result.rows[0].full_name,
          role: result.rows[0].role,
        };
        return next();
      }
    } catch (jwtError) {
      // Not a valid JWT, try customer session
      const sessionResult = await query(
        `SELECT cs.id, cs.customer_id, cs.machine_id, cs.expires_at, u.email, u.role, u.full_name
         FROM customer_sessions cs
         LEFT JOIN users u ON cs.customer_id = u.id
         WHERE cs.session_token = $1 AND cs.expires_at > NOW()`,
        [token]
      );

      if (sessionResult.rows.length > 0) {
        const session = sessionResult.rows[0];
        req.session = {
          id: session.id,
          customerId: session.customer_id,
          machineId: session.machine_id,
        };
        if (session.customer_id) {
          req.user = {
            id: session.customer_id,
            email: session.email,
            fullName: session.full_name,
            role: session.role || 'customer',
          };
        }
        return next();
      }
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token.',
    });
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error verifying authentication.',
    });
  }
};

// Role restriction middleware
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated.',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access forbidden. Insufficient permissions.',
      });
    }

    next();
  };
};

module.exports = {
  verifyToken,
  verifyCustomerSession,
  authorize,
  protect,
  restrictTo,
};
