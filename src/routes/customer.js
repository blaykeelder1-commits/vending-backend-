const express = require('express');
const Joi = require('joi');
const { query } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const { verifyCustomerSession } = require('../middleware/auth');

const router = express.Router();

// Most routes require customer session (QR-based auth)
router.use(verifyCustomerSession);

// ========================================
// POLLS ROUTES
// ========================================

/**
 * GET /api/customer/polls
 * Get all active polls for the customer's current machine
 */
router.get('/polls', async (req, res) => {
  try {
    const { machineId } = req.session;

    const result = await query(
      `SELECT p.id, p.question, p.is_active, p.created_at, p.expires_at,
              vm.machine_name, vm.location
       FROM polls p
       JOIN vending_machines vm ON p.machine_id = vm.id
       WHERE p.machine_id = $1 AND p.is_active = true
       AND (p.expires_at IS NULL OR p.expires_at > NOW())
       ORDER BY p.created_at DESC`,
      [machineId]
    );

    // Get poll options for each poll
    const pollsWithOptions = await Promise.all(
      result.rows.map(async (poll) => {
        const optionsResult = await query(
          `SELECT po.id, po.option_text, po.product_id, p.product_name, p.image_url,
                  COUNT(pv.id) as vote_count
           FROM poll_options po
           LEFT JOIN products p ON po.product_id = p.id
           LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id
           WHERE po.poll_id = $1
           GROUP BY po.id, po.option_text, po.product_id, p.product_name, p.image_url
           ORDER BY po.id`,
          [poll.id]
        );

        // Check if customer has voted on this poll
        let hasVoted = false;
        if (req.session.customerId) {
          const voteCheck = await query(
            `SELECT id FROM poll_votes
             WHERE poll_id = $1 AND customer_id = $2`,
            [poll.id, req.session.customerId]
          );
          hasVoted = voteCheck.rows.length > 0;
        }

        return {
          ...poll,
          options: optionsResult.rows,
          hasVoted,
        };
      })
    );

    res.json({
      success: true,
      data: {
        polls: pollsWithOptions,
        count: pollsWithOptions.length,
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
 * Vote on a poll
 */
router.post('/polls/:pollId/vote', async (req, res) => {
  try {
    const { pollId } = req.params;
    const schema = Joi.object({
      pollOptionId: Joi.number().integer().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { pollOptionId } = value;

    // Verify poll exists and is active
    const pollCheck = await query(
      `SELECT id, machine_id, is_active, expires_at
       FROM polls
       WHERE id = $1`,
      [pollId]
    );

    if (pollCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Poll not found',
      });
    }

    const poll = pollCheck.rows[0];

    if (!poll.is_active) {
      return res.status(400).json({
        success: false,
        message: 'This poll is no longer active',
      });
    }

    if (poll.expires_at && new Date(poll.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'This poll has expired',
      });
    }

    // Verify poll option belongs to this poll
    const optionCheck = await query(
      'SELECT id FROM poll_options WHERE id = $1 AND poll_id = $2',
      [pollOptionId, pollId]
    );

    if (optionCheck.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid poll option',
      });
    }

    // Check if customer already voted (if they're registered)
    if (req.session.customerId) {
      const existingVote = await query(
        'SELECT id FROM poll_votes WHERE poll_id = $1 AND customer_id = $2',
        [pollId, req.session.customerId]
      );

      if (existingVote.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'You have already voted on this poll',
        });
      }
    }

    // Record the vote
    const voteResult = await query(
      `INSERT INTO poll_votes (poll_id, poll_option_id, customer_id, session_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [pollId, pollOptionId, req.session.customerId || null, req.session.id]
    );

    res.json({
      success: true,
      message: 'Vote recorded successfully',
      data: { vote: voteResult.rows[0] },
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
      `SELECT mp.id, mp.stock_quantity, mp.slot_number,
              p.id as product_id, p.product_name, p.description, p.price,
              p.image_url, p.category
       FROM machine_products mp
       JOIN products p ON mp.product_id = p.id
       WHERE mp.machine_id = $1 AND p.is_active = true
       ORDER BY mp.slot_number`,
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
      `SELECT id, email, full_name, phone, created_at
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

module.exports = router;
