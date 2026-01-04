const express = require('express');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const User = require('../models/User');
const CustomerSession = require('../models/CustomerSession');
const { validateQRCodeData } = require('../services/qrCodeService');
const { query } = require('../config/database');

const router = express.Router();

// Validation schemas
const vendorRegisterSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  fullName: Joi.string().min(2).required(),
});

const vendorLoginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const qrLoginSchema = Joi.object({
  qrData: Joi.string().required(),
});

/**
 * POST /api/auth/vendor/register
 * Register a new vendor account
 */
router.post('/vendor/register', async (req, res) => {
  try {
    // Validate input
    const { error, value } = vendorRegisterSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email, password, fullName } = value;

    // Create vendor user
    const user = await User.createVendor({ email, password, fullName });

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    res.status(201).json({
      success: true,
      message: 'Vendor registered successfully',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
        },
        token,
      },
    });
  } catch (error) {
    console.error('Vendor registration error:', error);
    if (error.message === 'Email already exists') {
      return res.status(409).json({
        success: false,
        message: 'Email already registered',
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error registering vendor',
    });
  }
});

/**
 * POST /api/auth/vendor/login
 * Login vendor with email and password
 */
router.post('/vendor/login', async (req, res) => {
  try {
    // Validate input
    const { error, value } = vendorLoginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email, password } = value;

    // Find vendor user
    const user = await User.findByEmail(email);

    if (!user || user.role !== 'vendor') {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    // Verify password
    const isValidPassword = await User.verifyPassword(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
        },
        token,
      },
    });
  } catch (error) {
    console.error('Vendor login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error logging in',
    });
  }
});

/**
 * POST /api/auth/customer/qr-login
 * Login customer by scanning QR code
 */
router.post('/customer/qr-login', async (req, res) => {
  try {
    // Validate input
    const { error, value } = qrLoginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { qrData } = value;

    // Validate and decrypt QR code
    let qrPayload;
    try {
      qrPayload = validateQRCodeData(qrData);
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: 'Invalid QR code: ' + err.message,
      });
    }

    const { machineId } = qrPayload;

    // Verify machine exists and is active
    const machineResult = await query(
      'SELECT id, machine_name, location, is_active FROM vending_machines WHERE id = $1',
      [machineId]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    const machine = machineResult.rows[0];

    if (!machine.is_active) {
      return res.status(403).json({
        success: false,
        message: 'This vending machine is currently inactive',
      });
    }

    // Create customer session (anonymous for now)
    const session = await CustomerSession.create({
      machineId: machine.id,
      qrCodeScanned: qrData,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      success: true,
      message: 'QR login successful',
      data: {
        sessionToken: session.session_token,
        machine: {
          id: machine.id,
          name: machine.machine_name,
          location: machine.location,
        },
        expiresAt: session.expires_at,
      },
    });
  } catch (error) {
    console.error('Customer QR login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing QR login',
    });
  }
});

/**
 * GET /api/auth/verify
 * Verify current authentication token
 */
router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided',
      });
    }

    // Try JWT verification first (vendor)
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);

      if (user && user.role === 'vendor') {
        return res.json({
          success: true,
          data: {
            type: 'vendor',
            user: {
              id: user.id,
              email: user.email,
              fullName: user.full_name,
              role: user.role,
            },
          },
        });
      }
    } catch (jwtError) {
      // Not a JWT, try customer session
    }

    // Try customer session verification
    const session = await CustomerSession.findByToken(token);

    if (session && new Date(session.expires_at) > new Date()) {
      return res.json({
        success: true,
        data: {
          type: 'customer',
          sessionId: session.id,
          machineId: session.machine_id,
          customerId: session.customer_id,
          expiresAt: session.expires_at,
        },
      });
    }

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying token',
    });
  }
});

module.exports = router;
