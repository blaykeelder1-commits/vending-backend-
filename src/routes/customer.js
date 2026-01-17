const express = require('express');
const Joi = require('joi');
const { query, transaction } = require('../config/database');

const router = express.Router();

/**
 * POST /api/customer/set-machine
 * Set machine session from QR code scan (anonymous)
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

    // Verify machine exists and is active
    const machineCheck = await query(
      'SELECT id, machine_name, location FROM vending_machines WHERE id = $1 AND is_active = true',
      [machineId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found or inactive',
      });
    }

    // Create anonymous session
    const sessionToken = require('crypto').randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await query(
      `INSERT INTO customer_sessions (machine_id, session_token, expires_at, qr_code_scanned)
       VALUES ($1, $2, $3, true)`,
      [machineId, sessionToken, expiresAt]
    );

    res.json({
      success: true,
      message: 'Machine session created',
      data: {
        sessionToken,
        machine: machineCheck.rows[0],
      },
    });
  } catch (error) {
    console.error('Error setting machine:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating machine session',
    });
  }
});

/**
 * Middleware to verify session token for anonymous access
 */
const verifySession = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Session token required',
      });
    }

    const result = await query(
      `SELECT id, machine_id, expires_at FROM customer_sessions
       WHERE session_token = $1 AND expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired session',
      });
    }

    req.session = {
      id: result.rows[0].id,
      machineId: result.rows[0].machine_id,
    };

    next();
  } catch (error) {
    console.error('Session verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Session verification failed',
    });
  }
};

// ========================================
// MACHINE INFO ROUTES
// ========================================

/**
 * GET /api/customer/machine
 * Get current machine info and available products
 */
router.get('/machine', verifySession, async (req, res) => {
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
      `SELECT mp.id, mp.current_stock, mp.is_performing,
              p.id as product_id, p.product_name, p.description, p.price,
              p.image_url, p.category
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

// ========================================
// SWIPE POLL ROUTES (Tinder-style voting)
// ========================================

/**
 * GET /api/customer/polls
 * Get active swipe poll for the current machine
 * If no vendor-created poll exists, auto-generates one from underperforming products
 */
router.get('/polls', verifySession, async (req, res) => {
  try {
    const { machineId } = req.session;
    const sessionId = req.session.id;

    // Get active poll for this machine
    let pollResult = await query(
      `SELECT p.id, p.poll_question as question, p.created_at, p.poll_type, p.is_auto_generated
       FROM polls p
       WHERE p.machine_id = $1 AND p.is_active = true
       ORDER BY p.created_at DESC
       LIMIT 1`,
      [machineId]
    );

    let poll = pollResult.rows[0];

    // If no active poll exists, auto-generate one from underperforming products
    if (!poll) {
      // Get machine info for the poll question
      const machineInfo = await query(
        `SELECT vm.id, vm.machine_name, vm.vendor_id
         FROM vending_machines vm
         WHERE vm.id = $1`,
        [machineId]
      );

      if (machineInfo.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Machine not found',
        });
      }

      const machine = machineInfo.rows[0];

      // Get underperforming products (is_performing = false OR is_performing IS NULL)
      const underperformersResult = await query(
        `SELECT mp.id as machine_product_id, mp.product_id,
                p.product_name, p.image_url
         FROM machine_products mp
         JOIN products p ON mp.product_id = p.id
         WHERE mp.machine_id = $1
           AND (mp.is_performing = false OR mp.is_performing IS NULL)
           AND p.is_active = true
         ORDER BY mp.is_performing ASC NULLS LAST, p.product_name
         LIMIT 20`,
        [machineId]
      );

      // If no underperformers, try to get any products from this machine
      let productsToShow = underperformersResult.rows;

      if (productsToShow.length === 0) {
        const anyProductsResult = await query(
          `SELECT mp.id as machine_product_id, mp.product_id,
                  p.product_name, p.image_url
           FROM machine_products mp
           JOIN products p ON mp.product_id = p.id
           WHERE mp.machine_id = $1 AND p.is_active = true
           ORDER BY p.product_name
           LIMIT 20`,
          [machineId]
        );
        productsToShow = anyProductsResult.rows;
      }

      // If still no products, return no poll
      if (productsToShow.length < 2) {
        return res.json({
          success: true,
          data: {
            poll: null,
            products: [],
            message: 'Not enough products in this machine for a poll',
          },
        });
      }

      // Create auto-generated poll using a transaction
      const autoPollResult = await transaction(async (client) => {
        // Deactivate any existing auto-generated polls for this machine
        await client.query(
          `UPDATE polls SET is_active = false, closed_at = NOW()
           WHERE machine_id = $1 AND is_auto_generated = true AND is_active = true`,
          [machineId]
        );

        // Create new auto-generated poll
        const pollInsert = await client.query(
          `INSERT INTO polls (vendor_id, machine_id, poll_question, is_active, poll_type, is_auto_generated)
           VALUES ($1, $2, $3, true, 'performance', true)
           RETURNING id, poll_question as question, created_at, poll_type, is_auto_generated`,
          [machine.vendor_id, machineId, 'Which products would you like to see more of?']
        );

        const newPoll = pollInsert.rows[0];

        // Insert poll options for each product
        for (let i = 0; i < productsToShow.length; i++) {
          const product = productsToShow[i];
          await client.query(
            `INSERT INTO poll_options (poll_id, option_text, image_url, product_id, display_order)
             VALUES ($1, $2, $3, $4, $5)`,
            [newPoll.id, product.product_name, product.image_url, product.product_id, i + 1]
          );
        }

        return newPoll;
      });

      poll = autoPollResult;
    }

    // Get poll options (products to swipe on) with user's existing votes
    const optionsResult = await query(
      `SELECT po.id, po.option_text as product_name, po.image_url, po.display_order,
              CASE WHEN pv.id IS NOT NULL THEN pv.vote_type ELSE NULL END as user_vote
       FROM poll_options po
       LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id AND pv.session_id = $2
       WHERE po.poll_id = $1
       ORDER BY po.display_order`,
      [poll.id, sessionId]
    );

    // Filter out already-voted options for fresh swipe experience
    const unvotedOptions = optionsResult.rows.filter((opt) => opt.user_vote === null);
    const votedCount = optionsResult.rows.length - unvotedOptions.length;

    res.json({
      success: true,
      data: {
        poll: {
          id: poll.id,
          question: poll.question,
          createdAt: poll.created_at,
          pollType: poll.poll_type || 'performance',
          isAutoGenerated: poll.is_auto_generated || false,
        },
        products: unvotedOptions,
        totalProducts: optionsResult.rows.length,
        votedCount,
        remainingCount: unvotedOptions.length,
      },
    });
  } catch (error) {
    console.error('Error fetching polls:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching poll',
    });
  }
});

/**
 * POST /api/customer/polls/:pollId/vote
 * Swipe vote on a product (like = swipe right, dislike = swipe left)
 */
router.post('/polls/:pollId/vote', verifySession, async (req, res) => {
  try {
    const { pollId } = req.params;
    const sessionId = req.session.id;

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

    // Verify poll option exists and poll is active
    const optionCheck = await query(
      `SELECT po.id, po.poll_id, p.is_active, p.machine_id
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

    // Verify session is for this machine
    if (option.machine_id !== req.session.machineId) {
      return res.status(403).json({
        success: false,
        message: 'Poll does not belong to your current machine',
      });
    }

    // Use transaction with row-level lock to prevent duplicate votes
    const voteResult = await transaction(async (client) => {
      // Check if already voted with FOR UPDATE SKIP LOCKED to prevent race condition
      const existingVote = await client.query(
        `SELECT id FROM poll_votes WHERE poll_option_id = $1 AND session_id = $2 FOR UPDATE`,
        [optionId, sessionId]
      );

      if (existingVote.rows.length > 0) {
        return { alreadyVoted: true };
      }

      // Record vote
      await client.query(
        `INSERT INTO poll_votes (poll_id, poll_option_id, session_id, vote_type)
         VALUES ($1, $2, $3, $4)`,
        [pollId, optionId, sessionId, voteType]
      );

      return { alreadyVoted: false };
    });

    if (voteResult.alreadyVoted) {
      return res.status(400).json({
        success: false,
        message: 'You have already voted on this product',
      });
    }

    // Get remaining count
    const remainingResult = await query(
      `SELECT COUNT(*) as remaining FROM poll_options po
       WHERE po.poll_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM poll_votes pv
         WHERE pv.poll_option_id = po.id AND pv.session_id = $2
       )`,
      [pollId, sessionId]
    );

    const remaining = parseInt(remainingResult.rows[0].remaining);

    res.json({
      success: true,
      message: voteType === 'like' ? 'You want this product!' : 'Not interested',
      data: {
        voteType,
        remainingProducts: remaining,
        isComplete: remaining === 0,
      },
    });
  } catch (error) {
    console.error('Error voting on poll:', error);
    res.status(500).json({
      success: false,
      message: 'Error recording vote',
    });
  }
});

/**
 * GET /api/customer/polls/:pollId/results
 * Get current poll results (optional - show what others voted)
 */
router.get('/polls/:pollId/results', verifySession, async (req, res) => {
  try {
    const { pollId } = req.params;

    const resultsQuery = await query(
      `SELECT
        po.id,
        po.option_text as product_name,
        po.image_url,
        COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END) as likes,
        COUNT(CASE WHEN pv.vote_type = 'dislike' THEN 1 END) as dislikes,
        COUNT(pv.id) as total_votes
       FROM poll_options po
       LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id
       WHERE po.poll_id = $1
       GROUP BY po.id, po.option_text, po.image_url
       ORDER BY likes DESC`,
      [pollId]
    );

    res.json({
      success: true,
      data: {
        results: resultsQuery.rows.map((row) => ({
          ...row,
          approvalRate:
            row.total_votes > 0 ? Math.round((row.likes / row.total_votes) * 100) : 0,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching poll results:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching results',
    });
  }
});

// ========================================
// PRODUCT SUGGESTIONS
// ========================================

/**
 * POST /api/customer/suggestions
 * Submit a product suggestion for this machine
 * Allows customers to suggest products they'd like to see
 */
router.post('/suggestions', verifySession, async (req, res) => {
  try {
    const { machineId, id: sessionId } = req.session;

    const schema = Joi.object({
      suggestion: Joi.string().min(2).max(255).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { suggestion } = value;

    // Insert the suggestion
    const result = await query(
      `INSERT INTO product_suggestions (machine_id, suggestion_text, customer_session_id)
       VALUES ($1, $2, $3)
       RETURNING id, suggestion_text, created_at`,
      [machineId, suggestion.trim(), sessionId]
    );

    res.json({
      success: true,
      message: 'Thank you! Your suggestion has been sent to the vendor.',
      data: {
        suggestion: result.rows[0],
      },
    });
  } catch (error) {
    console.error('Error submitting suggestion:', error);
    res.status(500).json({
      success: false,
      message: 'Error submitting suggestion',
    });
  }
});

module.exports = router;
