const express = require('express');
const Joi = require('joi');
const { query } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const { verifyCustomerSession } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const router = express.Router();

/**
 * POST /api/customer/set-machine
 * Set machine session (doesn't require existing session)
 */
router.post('/set-machine', async (req, res) => {
  try {
    const schema = Joi.object({
      machineId: Joi.number().integer().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { machineId } = value;

    // Verify machine exists
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1',
      [machineId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    // Set machine session
    req.session.machineId = machineId;

    res.json({
      success: true,
      message: 'Machine session set',
      data: { machineId },
    });
  } catch (error) {
    console.error('Error setting machine:', error);
    res.status(500).json({
      success: false,
      message: 'Error setting machine session',
    });
  }
});

// Most routes require customer session (QR-based auth)
router.use(protect);

// ========================================
// POLLS ROUTES
// ========================================

/**
 * GET /api/customer/polls
 * Get all active polls for the customer's current machine
 */
router.get('/polls', async (req, res) => {
  try {
    const customerId = req.session?.customerId || req.user?.id;
    const machineId = req.session?.machineId || req.query.machineId;

    if (!machineId) {
      return res.status(400).json({
        success: false,
        message: 'Machine ID required',
      });
    }

    const result = await query(
      `SELECT p.id, p.poll_question as question, p.is_active, p.created_at
       FROM polls p
       WHERE p.machine_id = $1 AND p.is_active = true
       ORDER BY p.created_at DESC
       LIMIT 1`,
      [machineId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          poll: null,
          options: [],
        },
      });
    }

    const poll = result.rows[0];

    // Get poll options with vote status
    const optionsResult = await query(
      `SELECT po.id, po.option_text, po.image_url, po.display_order,
              CASE WHEN pv.id IS NOT NULL THEN pv.vote_type ELSE NULL END as user_vote
       FROM poll_options po
       LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id AND pv.customer_id = $2
       WHERE po.poll_id = $1
       ORDER BY po.display_order`,
      [poll.id, customerId]
    );

    res.json({
      success: true,
      data: {
        poll,
        options: optionsResult.rows,
      },
    });
  } catch (error) {
    console.error('Error fetching polls:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching polls',
    });
  }
});

/**
 * POST /api/customer/polls/:pollId/vote
 * Vote on a poll option (swipe-style: approve or deny)
 */
router.post('/polls/:pollId/vote', async (req, res) => {
  try {
    const { pollId } = req.params;
    const customerId = req.session?.customerId || req.user?.id;

    if (!customerId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required to vote',
      });
    }

    const schema = Joi.object({
      optionId: Joi.number().integer().required(),
      voteType: Joi.string().valid('like', 'dislike').required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { optionId, voteType } = value;

    // Verify poll option exists and belongs to poll
    const optionCheck = await query(
      `SELECT po.id, po.poll_id, p.is_active
       FROM poll_options po
       JOIN polls p ON po.poll_id = p.id
       WHERE po.id = $1 AND po.poll_id = $2`,
      [optionId, pollId]
    );

    if (optionCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Poll option not found',
      });
    }

    const option = optionCheck.rows[0];

    if (!option.is_active) {
      return res.status(400).json({
        success: false,
        message: 'This poll is no longer active',
      });
    }

    // Check if already voted on this option
    const existingVote = await query(
      'SELECT id FROM poll_votes WHERE poll_option_id = $1 AND customer_id = $2',
      [optionId, customerId]
    );

    if (existingVote.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'You have already voted on this option',
      });
    }

    // Record vote
    await query(
      `INSERT INTO poll_votes (poll_id, poll_option_id, customer_id, vote_type)
       VALUES ($1, $2, $3, $4)`,
      [pollId, optionId, customerId, voteType]
    );

    res.json({
      success: true,
      message: 'Vote recorded successfully',
    });
  } catch (error) {
    console.error('Error voting on poll:', error);
    res.status(500).json({
      success: false,
      message: 'Error recording vote',
    });
  }
});

// ========================================
// REBATES ROUTES
// ========================================

/**
 * GET /api/customer/rebates
 * Get customer's rebate requests (requires registered customer)
 */
router.get('/rebates', async (req, res) => {
  try {
    if (!req.session.customerId) {
      return res.status(401).json({
        success: false,
        message: 'Please register to view rebate history',
      });
    }

    const result = await query(
      `SELECT r.id, r.product_name, r.purchase_price, r.receipt_image_url,
              r.status, r.vendor_notes, r.created_at, r.processed_at
       FROM rebates r
       WHERE r.customer_id = $1
       ORDER BY r.created_at DESC`,
      [req.session.customerId]
    );

    res.json({
      success: true,
      data: {
        rebates: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching rebates:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching rebates',
    });
  }
});

/**
 * POST /api/customer/rebates
 * Submit a rebate request (requires registered customer)
 */
router.post('/rebates', async (req, res) => {
  try {
    if (!req.session.customerId) {
      return res.status(401).json({
        success: false,
        message: 'Please register to submit rebate requests',
      });
    }

    const schema = Joi.object({
      productName: Joi.string().min(2).max(255).required(),
      purchasePrice: Joi.number().min(0).precision(2).required(),
      receiptImageUrl: Joi.string().uri().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { productName, purchasePrice, receiptImageUrl } = value;

    // Get vendor from current machine
    const machineResult = await query(
      'SELECT vendor_id FROM vending_machines WHERE id = $1',
      [req.session.machineId]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    const vendorId = machineResult.rows[0].vendor_id;

    const result = await query(
      `INSERT INTO rebates (customer_id, vendor_id, product_name, purchase_price, receipt_image_url, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id, product_name, purchase_price, receipt_image_url, status, created_at`,
      [req.session.customerId, vendorId, productName, purchasePrice, receiptImageUrl]
    );

    res.status(201).json({
      success: true,
      message: 'Rebate request submitted successfully',
      data: { rebate: result.rows[0] },
    });
  } catch (error) {
    console.error('Error submitting rebate:', error);
    res.status(500).json({
      success: false,
      message: 'Error submitting rebate request',
    });
  }
});

// ========================================
// LOYALTY POINTS ROUTES
// ========================================

/**
 * GET /api/customer/loyalty
 * Get customer's loyalty points balance (requires registered customer)
 */
router.get('/loyalty', async (req, res) => {
  try {
    if (!req.session.customerId) {
      return res.status(401).json({
        success: false,
        message: 'Please register to view loyalty points',
      });
    }

    const result = await query(
      `SELECT lp.id, lp.points_balance, lp.lifetime_points, lp.updated_at,
              vm.machine_name, vm.location
       FROM loyalty_points lp
       JOIN vending_machines vm ON lp.machine_id = vm.id
       WHERE lp.customer_id = $1
       ORDER BY lp.points_balance DESC`,
      [req.session.customerId]
    );

    // Calculate total points across all machines
    const totalPoints = result.rows.reduce((sum, row) => sum + parseInt(row.points_balance), 0);
    const totalLifetimePoints = result.rows.reduce((sum, row) => sum + parseInt(row.lifetime_points), 0);

    res.json({
      success: true,
      data: {
        loyaltyAccounts: result.rows,
        totalPoints,
        totalLifetimePoints,
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching loyalty points:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching loyalty points',
    });
  }
});

/**
 * GET /api/customer/loyalty/:machineId
 * Get loyalty points for a specific machine
 */
router.get('/loyalty/:machineId', async (req, res) => {
  try {
    if (!req.session.customerId) {
      return res.status(401).json({
        success: false,
        message: 'Please register to view loyalty points',
      });
    }

    const { machineId } = req.params;

    const result = await query(
      `SELECT lp.id, lp.points_balance, lp.lifetime_points, lp.created_at, lp.updated_at,
              vm.machine_name, vm.location
       FROM loyalty_points lp
       JOIN vending_machines vm ON lp.machine_id = vm.id
       WHERE lp.customer_id = $1 AND lp.machine_id = $2`,
      [req.session.customerId, machineId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No loyalty account found for this machine',
      });
    }

    res.json({
      success: true,
      data: { loyalty: result.rows[0] },
    });
  } catch (error) {
    console.error('Error fetching loyalty points:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching loyalty points',
    });
  }
});

// ========================================
// MACHINE & PRODUCTS ROUTES
// ========================================

/**
 * GET /api/customer/machine
 * Get current machine info and available products
 */
router.get('/machine', async (req, res) => {
  try {
    const { machineId } = req.session;

    // Get machine info
    const machineResult = await query(
      `SELECT id, machine_name, location, is_active
       FROM vending_machines
       WHERE id = $1`,
      [machineId]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    // Get available products in this machine
    const productsResult = await query(
      `SELECT mp.id, mp.current_stock,
              p.id as product_id, p.product_name, p.description, p.price,
              p.image_url
       FROM machine_products mp
       JOIN products p ON mp.product_id = p.id
       WHERE mp.machine_id = $1 AND p.is_active = true
       ORDER BY p.product_name`,
      [machineId]
    );

    res.json({
      success: true,
      data: {
        machine: machineResult.rows[0],
        products: productsResult.rows,
        productsCount: productsResult.rows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching machine info:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching machine information',
    });
  }
});

/**
 * GET /api/customer/profile
 * Get customer profile (requires registered customer)
 */
router.get('/profile', async (req, res) => {
  try {
    if (!req.session.customerId) {
      return res.status(401).json({
        success: false,
        message: 'Please register to view profile',
      });
    }

    const result = await query(
      `SELECT id, email, full_name, created_at
       FROM users
       WHERE id = $1 AND role = 'customer'`,
      [req.session.customerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Profile not found',
      });
    }

    res.json({
      success: true,
      data: { profile: result.rows[0] },
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching profile',
    });
  }
});

/**
 * GET /api/customer/machine/discounts
 * Get active discount codes for the current machine
 */
router.get('/machine/discounts', async (req, res) => {
  try {
    const machineId = req.query.machineId ? parseInt(req.query.machineId) : req.session.machineId;

    if (!machineId) {
      return res.status(400).json({
        success: false,
        message: 'Machine ID required (session or query param)',
      });
    }

    const result = await query(
      `SELECT dc.id, dc.code, dc.discount_type, dc.discount_value,
              dc.valid_from, dc.valid_until, dc.max_uses, dc.current_uses,
              p.product_name, p.price
       FROM discount_codes dc
       LEFT JOIN products p ON dc.product_id = p.id
       WHERE dc.machine_id = $1 AND dc.is_active = true
       AND (dc.valid_from IS NULL OR dc.valid_from <= NOW())
       AND (dc.valid_until IS NULL OR dc.valid_until >= NOW())
       ORDER BY dc.created_at DESC`,
      [machineId]
    );

    res.json({
      success: true,
      data: {
        discounts: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching machine discounts:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching discounts',
    });
  }
});

/**
 * POST /api/customer/loyalty/submit
 * Submit loyalty points for current session
 */
router.post('/loyalty/submit', async (req, res) => {
  try {
    const { machineId } = req.session;
    const customerId = req.session.customerId || null;

    if (!machineId) {
      return res.status(400).json({
        success: false,
        message: 'No machine session found',
      });
    }

    const schema = Joi.object({
      pointsEarned: Joi.number().integer().min(1).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { pointsEarned } = value;

    // For now, allow anonymous points submission (customerId can be null)
    // Later this will be tied to registered customers only
    if (!customerId) {
      return res.status(401).json({
        success: false,
        message: 'Please register to earn loyalty points',
      });
    }

    // Upsert loyalty points
    const result = await query(
      `INSERT INTO loyalty_points (customer_id, machine_id, points_balance, lifetime_points, points_earned, transaction_type, description)
       VALUES ($1, $2, $3, $3, $3, 'manual_submission', 'Points submitted via customer portal')
       ON CONFLICT (customer_id, machine_id)
       DO UPDATE SET
         points_balance = loyalty_points.points_balance + $3,
         lifetime_points = loyalty_points.lifetime_points + $3,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, customer_id, machine_id, points_balance, lifetime_points, updated_at`,
      [customerId, machineId, pointsEarned]
    );

    res.json({
      success: true,
      message: 'Points submitted successfully',
      data: {
        loyalty: result.rows[0],
      },
    });
  } catch (error) {
    console.error('Error submitting loyalty points:', error);
    res.status(500).json({
      success: false,
      message: 'Error submitting points',
    });
  }
});

/**
 * POST /api/customer/discounts/redeem
 * Redeem a discount code
 */
router.post('/discounts/redeem', async (req, res) => {
  try {
    const { machineId } = req.session;
    const customerId = req.session.customerId || null;

    if (!machineId) {
      return res.status(400).json({
        success: false,
        message: 'No machine session found',
      });
    }

    if (!customerId) {
      return res.status(401).json({
        success: false,
        message: 'Please register to redeem discount codes',
      });
    }

    const schema = Joi.object({
      code: Joi.string().min(3).max(50).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { code } = value;

    // Find discount code
    const discountResult = await query(
      `SELECT id, machine_id, discount_type, discount_value, max_uses, current_uses,
              valid_from, valid_until, is_active
       FROM discount_codes
       WHERE code = $1`,
      [code.toUpperCase()]
    );

    if (discountResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Discount code not found',
      });
    }

    const discount = discountResult.rows[0];

    // Verify belongs to current machine
    if (discount.machine_id !== machineId) {
      return res.status(400).json({
        success: false,
        message: 'This discount code is not valid for this machine',
      });
    }

    // Verify is active
    if (!discount.is_active) {
      return res.status(400).json({
        success: false,
        message: 'This discount code is no longer active',
      });
    }

    // Verify valid_from
    if (discount.valid_from && new Date(discount.valid_from) > new Date()) {
      return res.status(400).json({
        success: false,
        message: 'This discount code is not yet valid',
      });
    }

    // Verify valid_until
    if (discount.valid_until && new Date(discount.valid_until) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'This discount code has expired',
      });
    }

    // Verify max_uses
    if (discount.max_uses && discount.current_uses >= discount.max_uses) {
      return res.status(400).json({
        success: false,
        message: 'This discount code has reached its maximum usage limit',
      });
    }

    // Check if customer already redeemed this code
    const redemptionCheck = await query(
      `SELECT id FROM discount_redemptions
       WHERE discount_code_id = $1 AND customer_id = $2`,
      [discount.id, customerId]
    );

    if (redemptionCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'You have already redeemed this discount code',
      });
    }

    // Record redemption
    await query(
      `INSERT INTO discount_redemptions (discount_code_id, customer_id, machine_id)
       VALUES ($1, $2, $3)`,
      [discount.id, customerId, machineId]
    );

    // Increment current_uses
    await query(
      `UPDATE discount_codes SET current_uses = current_uses + 1 WHERE id = $1`,
      [discount.id]
    );

    res.json({
      success: true,
      message: `Discount code redeemed! You saved ${discount.discount_value}%`,
      data: {
        discountType: discount.discount_type,
        discountValue: discount.discount_value,
      },
    });
  } catch (error) {
    console.error('Error redeeming discount:', error);
    res.status(500).json({
      success: false,
      message: 'Error redeeming discount code',
    });
  }
});

/**
 * POST /api/customer/redemptions/submit
 * Submit discount redemption with proof of purchase
 */
router.post('/redemptions/submit', upload.single('proofImage'), async (req, res) => {
  try {
    const customerId = req.session?.customerId || req.user?.id;

    if (!customerId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const schema = Joi.object({
      machineId: Joi.number().integer().required(),
      discountId: Joi.number().integer().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { machineId, discountId } = value;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Proof of purchase image required',
      });
    }

    const proofImageUrl = `/uploads/proofs/${req.file.filename}`;

    // Verify discount exists and is valid
    const discountResult = await query(
      `SELECT id, machine_id, code, discount_value, max_uses, current_uses, is_active,
              valid_from, valid_until
       FROM discount_codes
       WHERE id = $1`,
      [discountId]
    );

    if (discountResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Discount code not found',
      });
    }

    const discount = discountResult.rows[0];

    if (discount.machine_id !== machineId) {
      return res.status(400).json({
        success: false,
        message: 'Discount code does not belong to this machine',
      });
    }

    if (!discount.is_active) {
      return res.status(400).json({
        success: false,
        message: 'Discount code is no longer active',
      });
    }

    if (discount.valid_from && new Date(discount.valid_from) > new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Discount code is not yet valid',
      });
    }

    if (discount.valid_until && new Date(discount.valid_until) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Discount code has expired',
      });
    }

    if (discount.max_uses && discount.current_uses >= discount.max_uses) {
      return res.status(400).json({
        success: false,
        message: 'Discount code has reached maximum usage',
      });
    }

    // Check if already redeemed
    const existingRedemption = await query(
      `SELECT id FROM discount_redemptions
       WHERE discount_code_id = $1 AND customer_id = $2`,
      [discountId, customerId]
    );

    if (existingRedemption.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'You have already redeemed this discount',
      });
    }

    // MVP: Auto-approve and award points (10 points per redemption)
    const pointsAwarded = 10;
    const status = 'approved';

    // Create redemption record
    await query(
      `INSERT INTO discount_redemptions
       (discount_code_id, customer_id, machine_id, proof_image_url, status, points_awarded)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [discountId, customerId, machineId, proofImageUrl, status, pointsAwarded]
    );

    // Increment current_uses
    await query(
      `UPDATE discount_codes SET current_uses = current_uses + 1 WHERE id = $1`,
      [discountId]
    );

    // Award loyalty points
    const loyaltyCheck = await query(
      `SELECT id, points_balance FROM loyalty_points
       WHERE customer_id = $1 AND machine_id = $2`,
      [customerId, machineId]
    );

    if (loyaltyCheck.rows.length > 0) {
      await query(
        `UPDATE loyalty_points
         SET points_balance = points_balance + $1,
             lifetime_points = lifetime_points + $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE customer_id = $2 AND machine_id = $3`,
        [pointsAwarded, customerId, machineId]
      );
    } else {
      await query(
        `INSERT INTO loyalty_points (customer_id, machine_id, points_balance, lifetime_points)
         VALUES ($1, $2, $3, $4)`,
        [customerId, machineId, pointsAwarded, pointsAwarded]
      );
    }

    // Get updated loyalty totals
    const loyaltyTotals = await query(
      `SELECT SUM(points_balance) as total_points, SUM(lifetime_points) as total_lifetime_points
       FROM loyalty_points
       WHERE customer_id = $1`,
      [customerId]
    );

    res.json({
      success: true,
      message: `Discount redeemed! You earned ${pointsAwarded} points.`,
      data: {
        pointsAwarded,
        totalPoints: parseInt(loyaltyTotals.rows[0]?.total_points || 0),
        totalLifetimePoints: parseInt(loyaltyTotals.rows[0]?.total_lifetime_points || 0),
      },
    });
  } catch (error) {
    console.error('Error submitting redemption:', error);
    res.status(500).json({
      success: false,
      message: 'Error submitting redemption',
    });
  }
});

module.exports = router;
