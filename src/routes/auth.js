const express = require('express');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const CustomerSession = require('../models/CustomerSession');
const RefreshToken = require('../models/RefreshToken');
const { validateQRCodeData } = require('../services/qrCodeService');
const { query, transaction } = require('../config/database');
const { scheduleOnboardingSequence, sendEmail } = require('../services/emailService');

// Initialize Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const router = express.Router();

// Helper function to generate 6-digit verification code
const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Helper function to generate secure password reset token
const generateResetToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Helper function to hash token for storage
const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

// Helper function to generate refresh token
const generateRefreshToken = () => {
  return crypto.randomBytes(64).toString('hex');
};

// Refresh token expiration (7 days)
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

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

const customerRegisterSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  fullName: Joi.string().min(2).required(),
});

const customerLoginSchema = Joi.object({
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

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Create vendor user
    const user = await User.createVendor({ email: normalizedEmail, password, fullName });

    // Auto-verify email (email service not configured for public delivery yet)
    await query(
      `UPDATE users SET email_verified = true WHERE id = $1`,
      [user.id]
    );

    // Generate JWT access token so user can proceed immediately
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    // Generate refresh token
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Store refresh token
    await RefreshToken.create(user.id, refreshTokenHash, refreshExpiresAt);

    // Schedule onboarding emails (best-effort, won't block registration)
    scheduleOnboardingSequence(user.id, email, fullName).catch(err => {
      console.error('[Email] Error scheduling onboarding:', err);
    });

    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
        },
        token,
        refreshToken,
        emailVerified: true,
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

    // Find vendor user with verification status
    const userResult = await query(
      `SELECT id, email, password_hash, full_name, role, email_verified
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    const user = userResult.rows[0];

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

    // Auto-verify if not yet verified (legacy accounts)
    if (!user.email_verified) {
      query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]).catch(err => {
        console.error('Error auto-verifying user:', err);
      });
    }

    // Update last login timestamp
    query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]).catch(err => {
      console.error('Error updating last_login_at:', err);
    });

    // Generate JWT access token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    // Generate refresh token
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Store refresh token
    await RefreshToken.create(user.id, refreshTokenHash, refreshExpiresAt);

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
        refreshToken,
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
 * POST /api/auth/vendor/google
 * Login or register vendor with Google OAuth
 */
router.post('/vendor/google', async (req, res) => {
  try {
    const schema = Joi.object({
      credential: Joi.string().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { credential } = value;

    // Verify Google ID token
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (googleError) {
      console.error('Google token verification failed:', googleError);
      return res.status(401).json({
        success: false,
        message: 'Invalid Google credential',
      });
    }

    const { sub: googleId, email, name, picture } = payload;

    // Check if user exists by Google ID
    let user = await User.findByGoogleId(googleId);

    if (!user) {
      // Check if user exists by email (might have registered with email/password)
      const existingUser = await User.findByEmail(email);

      if (existingUser) {
        // If existing user is a vendor, link Google account
        if (existingUser.role === 'vendor') {
          await User.linkGoogleAccount(existingUser.id, {
            googleId,
            avatarUrl: picture,
          });
          user = await User.findById(existingUser.id);
        } else {
          return res.status(400).json({
            success: false,
            message: 'This email is registered as a customer account',
          });
        }
      } else {
        // Create new vendor user from Google
        user = await User.createVendorFromGoogle({
          googleId,
          email,
          fullName: name,
          avatarUrl: picture,
        });

        // Schedule onboarding emails for new users
        scheduleOnboardingSequence(user.id, email, name).catch(err => {
          console.error('[Email] Error scheduling onboarding:', err);
        });
      }
    }

    // Verify user is a vendor
    if (user.role !== 'vendor') {
      return res.status(403).json({
        success: false,
        message: 'Google sign-in is only available for vendor accounts',
      });
    }

    // Update last login timestamp
    query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]).catch(err => {
      console.error('Error updating last_login_at:', err);
    });

    // Generate JWT access token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    // Generate refresh token
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Store refresh token
    await RefreshToken.create(user.id, refreshTokenHash, refreshExpiresAt);

    // DEBUG ONLY: console.log(`[Auth] Google login successful for ${email}`);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
          avatarUrl: user.avatar_url,
        },
        token,
        refreshToken,
      },
    });
  } catch (error) {
    console.error('Google OAuth error:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing Google sign-in',
    });
  }
});

/**
 * POST /api/auth/vendor/verify-email
 * Verify vendor email with 6-digit code
 */
router.post('/vendor/verify-email', async (req, res) => {
  try {
    const schema = Joi.object({
      email: Joi.string().email().required(),
      code: Joi.string().length(6).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email, code } = value;

    // Find user with matching code
    const result = await query(
      `SELECT id, email, full_name, role, email_verified,
              email_verification_code, email_verification_expires
       FROM users
       WHERE email = $1 AND role = 'vendor'`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Account not found',
      });
    }

    const user = result.rows[0];

    // Check if already verified
    if (user.email_verified) {
      return res.status(400).json({
        success: false,
        message: 'Email is already verified',
      });
    }

    // Check if code matches
    if (user.email_verification_code !== code) {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification code',
      });
    }

    // Check if code has expired
    if (new Date(user.email_verification_expires) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new one.',
        code: 'CODE_EXPIRED',
      });
    }

    // Mark email as verified and clear the code
    await query(
      `UPDATE users SET
         email_verified = true,
         email_verification_code = NULL,
         email_verification_expires = NULL
       WHERE id = $1`,
      [user.id]
    );

    // Now schedule onboarding email sequence
    scheduleOnboardingSequence(user.id, user.email, user.full_name).catch(err => {
      console.error('[Email] Error scheduling onboarding:', err);
    });

    // Generate JWT access token so user can proceed to dashboard
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    // Generate refresh token
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Store refresh token
    await RefreshToken.create(user.id, refreshTokenHash, refreshExpiresAt);

    res.json({
      success: true,
      message: 'Email verified successfully!',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
        },
        token,
        refreshToken,
      },
    });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying email',
    });
  }
});

/**
 * POST /api/auth/vendor/resend-verification
 * Resend email verification code
 */
router.post('/vendor/resend-verification', async (req, res) => {
  try {
    const schema = Joi.object({
      email: Joi.string().email().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email } = value;

    // Find user
    const result = await query(
      `SELECT id, email, full_name, email_verified
       FROM users
       WHERE email = $1 AND role = 'vendor'`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      // Don't reveal if account exists
      return res.json({
        success: true,
        message: 'If an account exists with this email, a verification code has been sent.',
      });
    }

    const user = result.rows[0];

    // Check if already verified
    if (user.email_verified) {
      return res.status(400).json({
        success: false,
        message: 'Email is already verified. You can log in.',
      });
    }

    // Generate new verification code
    const verificationCode = generateVerificationCode();
    const verificationExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Update verification code
    await query(
      `UPDATE users SET
         email_verification_code = $1,
         email_verification_expires = $2
       WHERE id = $3`,
      [verificationCode, verificationExpires, user.id]
    );

    // Send verification email with retry
    let emailSent = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await sendEmail(email, 'emailVerification', {
          userName: user.full_name,
          verificationCode,
        });
        emailSent = true;
        break;
      } catch (err) {
        console.error(`[Email] Resend verification attempt ${attempt} failed:`, err.message);
      }
    }

    if (!emailSent) {
      return res.status(502).json({
        success: false,
        message: 'Unable to send verification email. Please try again later.',
      });
    }

    res.json({
      success: true,
      message: 'A new verification code has been sent to your email.',
    });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Error resending verification code',
    });
  }
});

/**
 * POST /api/auth/vendor/forgot-password
 * Request a password reset email
 */
router.post('/vendor/forgot-password', async (req, res) => {
  try {
    const schema = Joi.object({
      email: Joi.string().email().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email } = value;

    // Find user - don't reveal if account exists
    const result = await query(
      `SELECT id, email, full_name FROM users WHERE email = $1 AND role = 'vendor'`,
      [email.toLowerCase().trim()]
    );

    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent.',
      });
    }

    const user = result.rows[0];

    // Generate reset token (store hash, send raw token)
    const resetToken = generateResetToken();
    const resetTokenHash = hashToken(resetToken);
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store hashed token in database
    await query(
      `UPDATE users SET
         password_reset_token = $1,
         password_reset_expires = $2
       WHERE id = $3`,
      [resetTokenHash, resetExpires, user.id]
    );

    // Send password reset email with raw token
    sendEmail(email, 'passwordReset', {
      userName: user.full_name,
      resetToken,
    }).catch(err => {
      console.error('[Email] Error sending password reset email:', err);
    });

    // DEBUG ONLY: console.log(`[Auth] Password reset requested for ${email}`);

    res.json({
      success: true,
      message: 'If an account exists with this email, a password reset link has been sent.',
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing password reset request',
    });
  }
});

/**
 * POST /api/auth/vendor/reset-password
 * Reset password using token from email
 */
router.post('/vendor/reset-password', async (req, res) => {
  try {
    const schema = Joi.object({
      token: Joi.string().length(64).required(),
      password: Joi.string().min(6).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { token, password } = value;

    // Hash the provided token to compare with stored hash
    const tokenHash = hashToken(token);

    // Find user with matching token that hasn't expired
    const result = await query(
      `SELECT id, email, full_name FROM users
       WHERE password_reset_token = $1
         AND password_reset_expires > NOW()
         AND role = 'vendor'`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token. Please request a new password reset.',
        code: 'INVALID_TOKEN',
      });
    }

    const user = result.rows[0];

    // Hash the new password
    const bcrypt = require('bcrypt');
    const passwordHash = await bcrypt.hash(password, 10);

    // Update password and clear reset token
    await query(
      `UPDATE users SET
         password_hash = $1,
         password_reset_token = NULL,
         password_reset_expires = NULL
       WHERE id = $2`,
      [passwordHash, user.id]
    );

    // DEBUG ONLY: console.log(`[Auth] Password reset successful for ${user.email}`);

    // Send confirmation email
    sendEmail(user.email, 'passwordChanged', {
      userName: user.full_name,
    }).catch(err => {
      console.error('[Email] Error sending password changed email:', err);
    });

    res.json({
      success: true,
      message: 'Password has been reset successfully. You can now log in with your new password.',
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Error resetting password',
    });
  }
});

/**
 * POST /api/auth/customer/register
 * Register a new customer account
 */
router.post('/customer/register', async (req, res) => {
  try {
    // Validate input
    const { error, value } = customerRegisterSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email, password, fullName } = value;

    // Normalize email
    const normalizedEmail = email.trim().toLowerCase();

    // Create customer user
    const user = await User.createCustomerWithPassword({ email: normalizedEmail, password, fullName });

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    res.status(201).json({
      success: true,
      message: 'Customer registered successfully',
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
    console.error('Customer registration error:', error);
    if (error.message === 'Email already exists') {
      return res.status(409).json({
        success: false,
        message: 'Email already registered',
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error registering customer',
    });
  }
});

/**
 * POST /api/auth/customer/login
 * Login customer with email and password
 */
router.post('/customer/login', async (req, res) => {
  try {
    // Validate input
    const { error, value } = customerLoginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email, password } = value;

    // Normalize email
    const normalizedEmail = email.trim().toLowerCase();

    // Find customer user
    const user = await User.findByEmail(normalizedEmail);

    if (!user || user.role !== 'customer') {
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

    // Generate JWT access token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    // Generate refresh token
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Store refresh token
    await RefreshToken.create(user.id, refreshTokenHash, refreshExpiresAt);

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
        refreshToken,
      },
    });
  } catch (error) {
    console.error('Customer login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error logging in',
    });
  }
});

/**
 * POST /api/auth/customer/qr-login
 * Login customer by scanning QR code (binds authenticated customer to machine)
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

    // Check if customer is authenticated
    let customerId = null;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role === 'customer') {
          customerId = decoded.id;
        }
      } catch (jwtError) {
        // Token invalid, create anonymous session
      }
    }

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

    // Create customer session (with customerId if authenticated)
    const session = await CustomerSession.create({
      customerId,
      machineId: machine.id,
      qrCodeScanned: qrData,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      success: true,
      message: customerId ? 'QR scan successful - machine bound to account' : 'QR login successful',
      data: {
        sessionToken: session.session_token,
        machine: {
          id: machine.id,
          name: machine.machine_name,
          location: machine.location,
        },
        authenticated: !!customerId,
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

/**
 * GET /api/auth/public/machines/by-qr/:qr_token
 * Public endpoint to resolve QR token to machine
 */
router.get('/public/machines/by-qr/:qr_token', async (req, res) => {
  try {
    const { qr_token } = req.params;

    const result = await query(
      `SELECT id, machine_name, vendor_id FROM vending_machines WHERE qr_token = $1 AND is_active = true`,
      [qr_token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found or inactive'
      });
    }

    res.json({
      success: true,
      data: {
        machineId: result.rows[0].id,
        machineName: result.rows[0].machine_name,
        vendorId: result.rows[0].vendor_id
      }
    });
  } catch (err) {
    console.error('Error resolving QR token:', err);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token (with rotation)
 */
router.post('/refresh', async (req, res) => {
  try {
    const schema = Joi.object({
      refreshToken: Joi.string().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { refreshToken } = value;

    // Hash the provided refresh token to compare with stored hash
    const tokenHash = hashToken(refreshToken);

    // Find the refresh token in database
    const storedToken = await RefreshToken.findByToken(tokenHash);

    if (!storedToken) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired refresh token',
        code: 'INVALID_REFRESH_TOKEN',
      });
    }

    // Get the user associated with this refresh token
    const user = await User.findById(storedToken.user_id);

    if (!user) {
      // Delete the orphaned refresh token
      await RefreshToken.deleteByToken(tokenHash);
      return res.status(401).json({
        success: false,
        message: 'User not found',
      });
    }

    // Delete the old refresh token (rotation - each token can only be used once)
    await RefreshToken.deleteByToken(tokenHash);

    // Generate new access token
    const accessToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    // Generate new refresh token (rotation)
    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashToken(newRefreshToken);
    const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Store the new refresh token
    await RefreshToken.create(user.id, newRefreshTokenHash, newExpiresAt);

    // DEBUG ONLY: console.log(`[Auth] Token refreshed for user ${user.email}`);

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: process.env.JWT_EXPIRES_IN || '1h',
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
        },
      },
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({
      success: false,
      message: 'Error refreshing token',
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout and invalidate refresh token
 */
router.post('/logout', async (req, res) => {
  try {
    const schema = Joi.object({
      refreshToken: Joi.string().optional(),
    });

    const { value } = schema.validate(req.body);
    const { refreshToken } = value;

    if (refreshToken) {
      // Delete the specific refresh token
      const tokenHash = hashToken(refreshToken);
      await RefreshToken.deleteByToken(tokenHash);
    }

    // If user wants to logout from all devices, they can use /logout-all endpoint

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Error logging out',
    });
  }
});

module.exports = router;
