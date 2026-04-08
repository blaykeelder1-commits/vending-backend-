const express = require('express');
const crypto = require('crypto');
const Joi = require('joi');
const { query, transaction } = require('../config/database');
const analyticsService = require('../services/analyticsService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Helper: compute the start of the current poll period (most recent 15th)
 */
function getPollPeriodStart() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (now.getDate() >= 15) {
    return new Date(year, month, 15, 0, 0, 0, 0);
  }
  // Before the 15th → period started on the 15th of previous month
  return new Date(year, month - 1, 15, 0, 0, 0, 0);
}

/**
 * Helper: compute the next poll refresh date (next 15th)
 */
function getNextPollDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (now.getDate() < 15) {
    return new Date(year, month, 15, 0, 0, 0, 0);
  }
  return new Date(year, month + 1, 15, 0, 0, 0, 0);
}

/**
 * POST /api/customer/init-session
 * Combined endpoint: resolve QR → create session → check completion → load polls
 * Reduces 4 sequential round trips to 1
 */
router.post('/init-session', async (req, res) => {
  try {
    const schema = Joi.object({
      qr_token: Joi.string().required(),
      screenResolution: Joi.string().max(20).optional(),
      timezone: Joi.string().max(50).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const { qr_token, screenResolution, timezone } = value;

    // 1. Resolve QR token to machine (includes vendor_id to avoid second query)
    const machineResult = await query(
      'SELECT id, machine_name, location, vendor_id FROM vending_machines WHERE qr_token = $1 AND is_active = true',
      [qr_token]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Machine not found or inactive' });
    }

    const machine = machineResult.rows[0];
    const machineId = machine.id;

    // 2. Create session
    const fingerprintSource = `${req.ip}|${req.get('user-agent') || ''}|${screenResolution || ''}`;
    const deviceFingerprint = crypto.createHash('sha256').update(fingerprintSource).digest('hex').substring(0, 64);
    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const sessionResult = await query(
      `INSERT INTO customer_sessions (machine_id, session_token, expires_at, qr_code_scanned, ip_address, user_agent, device_fingerprint, screen_resolution, timezone)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8)
       RETURNING id`,
      [machineId, sessionToken, expiresAt, req.ip, req.get('user-agent'), deviceFingerprint, screenResolution || null, timezone || null]
    );

    const sessionId = sessionResult.rows[0].id;

    // Track QR scan (fire and forget)
    analyticsService.trackEvent({
      eventType: 'qr_scan',
      machineId,
      vendorId: machine.vendor_id,
      sessionId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // 3. Check poll completion + load poll in parallel-friendly way
    //    Single query: get active poll AND check if completed by this fingerprint this period
    const periodStart = getPollPeriodStart();
    const nextPollDate = getNextPollDate();

    const pollCheckResult = await query(
      `SELECT p.id, p.poll_question as question, p.created_at, p.poll_type, p.is_auto_generated,
              EXISTS(
                SELECT 1 FROM poll_completions pc
                WHERE pc.poll_id = p.id
                  AND (pc.session_id = $2 OR pc.device_fingerprint = $3)
                  AND pc.completed_at >= $4
              ) as already_completed
       FROM polls p
       WHERE p.machine_id = $1 AND p.is_active = true
       ORDER BY p.created_at DESC
       LIMIT 1`,
      [machineId, sessionId, deviceFingerprint, periodStart]
    );

    let poll = pollCheckResult.rows[0];
    const alreadyVoted = poll?.already_completed || false;

    // If already voted, return early with minimal data
    if (alreadyVoted) {
      return res.json({
        success: true,
        data: {
          sessionToken,
          machine: { id: machine.id, machine_name: machine.machine_name, location: machine.location },
          alreadyVoted: true,
          nextPollDate: nextPollDate.toISOString(),
          poll: null,
          products: [],
        },
      });
    }

    // 4. Load or auto-generate poll
    if (!poll) {
      // Auto-generate poll from machine products
      const underperformersResult = await query(
        `SELECT mp.id as machine_product_id, mp.product_id, p.product_name, p.image_url
         FROM machine_products mp
         JOIN products p ON mp.product_id = p.id
         WHERE mp.machine_id = $1 AND (mp.is_performing = false OR mp.is_performing IS NULL) AND p.is_active = true
         ORDER BY mp.is_performing ASC NULLS LAST, p.product_name LIMIT 20`,
        [machineId]
      );

      let productsToShow = underperformersResult.rows;

      if (productsToShow.length === 0) {
        const anyProducts = await query(
          `SELECT mp.id as machine_product_id, mp.product_id, p.product_name, p.image_url
           FROM machine_products mp JOIN products p ON mp.product_id = p.id
           WHERE mp.machine_id = $1 AND p.is_active = true
           ORDER BY p.product_name LIMIT 20`,
          [machineId]
        );
        productsToShow = anyProducts.rows;
      }

      if (productsToShow.length < 2) {
        return res.json({
          success: true,
          data: {
            sessionToken,
            machine: { id: machine.id, machine_name: machine.machine_name, location: machine.location },
            alreadyVoted: false,
            poll: null,
            products: [],
            message: 'Not enough products for a poll',
          },
        });
      }

      // Create auto-poll with batch insert for options
      poll = await transaction(async (client) => {
        await client.query(
          `UPDATE polls SET is_active = false, closed_at = NOW()
           WHERE machine_id = $1 AND is_auto_generated = true AND is_active = true`,
          [machineId]
        );

        const pollInsert = await client.query(
          `INSERT INTO polls (vendor_id, machine_id, poll_question, is_active, poll_type, is_auto_generated)
           VALUES ($1, $2, 'Which products would you like to see more of?', true, 'performance', true)
           RETURNING id, poll_question as question, created_at, poll_type, is_auto_generated`,
          [machine.vendor_id, machineId]
        );

        const newPoll = pollInsert.rows[0];

        // Batch insert all options in one query
        const values = productsToShow.map((p, i) =>
          `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4}, ${i + 1})`
        ).join(', ');
        const params = [newPoll.id];
        productsToShow.forEach(p => {
          params.push(p.product_name, p.image_url, p.product_id);
        });

        await client.query(
          `INSERT INTO poll_options (poll_id, option_text, image_url, product_id, display_order)
           VALUES ${values}`,
          params
        );

        return newPoll;
      });
    }

    // 5. Get poll options (unvoted only)
    const optionsResult = await query(
      `SELECT po.id, po.option_text as product_name, po.image_url, po.display_order,
              CASE WHEN pv.id IS NOT NULL THEN pv.vote_type ELSE NULL END as user_vote
       FROM poll_options po
       LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id AND pv.session_id = $2
       WHERE po.poll_id = $1
       ORDER BY po.display_order`,
      [poll.id, sessionId]
    );

    const unvotedOptions = optionsResult.rows.filter(opt => opt.user_vote === null);
    const votedCount = optionsResult.rows.length - unvotedOptions.length;

    res.json({
      success: true,
      data: {
        sessionToken,
        machine: { id: machine.id, machine_name: machine.machine_name, location: machine.location },
        alreadyVoted: false,
        nextPollDate: nextPollDate.toISOString(),
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
    logger.error('Error in init-session', { error: error.message });
    res.status(500).json({ success: false, message: 'Error initializing session' });
  }
});

/**
 * POST /api/customer/set-machine
 * Set machine session from QR code scan (anonymous)
 * (Legacy endpoint - kept for backwards compatibility)
 */
router.post('/set-machine', async (req, res) => {
  try {
    const schema = Joi.object({
      machineId: Joi.number().integer().required(),
      screenResolution: Joi.string().max(20).optional(),
      timezone: Joi.string().max(50).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { machineId, screenResolution, timezone } = value;

    // Compute device fingerprint from IP + user-agent + screen resolution
    const fingerprintSource = `${req.ip}|${req.get('user-agent') || ''}|${screenResolution || ''}`;
    const deviceFingerprint = crypto.createHash('sha256').update(fingerprintSource).digest('hex').substring(0, 64);

    // Verify machine exists and is active
    const machineCheck = await query(
      'SELECT id, machine_name, location, vendor_id FROM vending_machines WHERE id = $1 AND is_active = true',
      [machineId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found or inactive',
      });
    }

    // Create anonymous session
    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const sessionResult = await query(
      `INSERT INTO customer_sessions (machine_id, session_token, expires_at, qr_code_scanned, ip_address, user_agent, device_fingerprint, screen_resolution, timezone)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8)
       RETURNING id`,
      [machineId, sessionToken, expiresAt, req.ip, req.get('user-agent'), deviceFingerprint, screenResolution || null, timezone || null]
    );

    const sessionId = sessionResult.rows[0].id;

    // Track QR scan event (fire and forget)
    analyticsService.trackEvent({
      eventType: 'qr_scan',
      machineId,
      vendorId: machineCheck.rows[0].vendor_id,
      sessionId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      success: true,
      message: 'Machine session created',
      data: {
        sessionToken,
        machine: machineCheck.rows[0],
      },
    });
  } catch (error) {
    logger.error('Error setting machine', { error: error.message });
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
      `SELECT id, machine_id, expires_at, ip_address, ip_change_count FROM customer_sessions
       WHERE session_token = $1 AND expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired session',
      });
    }

    const session = result.rows[0];

    // IP validation — allow up to 3 IP changes (mobile WiFi/cellular switches)
    if (session.ip_address && req.ip !== session.ip_address) {
      const changeCount = session.ip_change_count || 0;
      if (changeCount >= 3) {
        return res.status(401).json({
          success: false,
          message: 'Session invalidated due to suspicious IP change',
        });
      }
      // Record the IP change
      await query(
        `UPDATE customer_sessions SET ip_address = $1, ip_change_count = COALESCE(ip_change_count, 0) + 1
         WHERE id = $2`,
        [req.ip, session.id]
      );
    }

    req.session = {
      id: session.id,
      machineId: session.machine_id,
    };

    next();
  } catch (error) {
    logger.error('Session verification error', { error: error.message });
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
    logger.error('Error fetching machine info', { error: error.message });
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
 * GET /api/customer/polls/check-completion
 * Check if this session or device fingerprint already completed the active poll
 */
router.get('/polls/check-completion', verifySession, async (req, res) => {
  try {
    const { machineId } = req.session;
    const sessionId = req.session.id;
    const periodStart = getPollPeriodStart();

    // Single query: check completion by session ID or device fingerprint within current period
    const result = await query(
      `SELECT EXISTS(
        SELECT 1 FROM poll_completions pc
        JOIN polls p ON pc.poll_id = p.id
        JOIN customer_sessions cs ON cs.id = $2
        WHERE p.machine_id = $1 AND p.is_active = true
          AND (pc.session_id = $2 OR pc.device_fingerprint = cs.device_fingerprint)
          AND pc.completed_at >= $3
      ) as completed`,
      [machineId, sessionId, periodStart]
    );

    res.json({
      success: true,
      data: {
        completed: result.rows[0].completed,
        nextPollDate: getNextPollDate().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Error checking poll completion', { error: error.message });
    res.status(500).json({ success: false, message: 'Error checking poll completion' });
  }
});

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

        // Batch insert poll options for all products
        if (productsToShow.length > 0) {
          const optionParams = [newPoll.id];
          const optionPlaceholders = productsToShow.map((product, i) => {
            const base = optionParams.length;
            optionParams.push(product.product_name, product.image_url, product.product_id);
            return `($1, $${base + 1}, $${base + 2}, $${base + 3}, ${i + 1})`;
          });
          await client.query(
            `INSERT INTO poll_options (poll_id, option_text, image_url, product_id, display_order)
             VALUES ${optionPlaceholders.join(', ')}`,
            optionParams
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
    logger.error('Error fetching polls', { error: error.message });
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

    // Insert vote, ignoring duplicates via unique constraint
    const voteResult = await query(
      `INSERT INTO poll_votes (poll_id, poll_option_id, session_id, vote_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (poll_option_id, session_id) DO NOTHING
       RETURNING id`,
      [pollId, optionId, sessionId, voteType]
    );

    if (voteResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'You have already voted on this product',
      });
    }

    // Get vendor ID for analytics tracking
    const vendorResult = await query(
      'SELECT vendor_id FROM vending_machines WHERE id = $1',
      [option.machine_id]
    );

    // Track poll vote event
    if (vendorResult.rows.length > 0) {
      analyticsService.trackEvent({
        eventType: 'poll_vote',
        machineId: option.machine_id,
        vendorId: vendorResult.rows[0].vendor_id,
        sessionId,
        metadata: {
          pollId: parseInt(pollId),
          optionId,
          voteType,
        },
      });

      // Update session activity
      analyticsService.updateSessionActivity(sessionId);
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

    // Record poll completion when all products have been voted on
    if (remaining === 0) {
      try {
        const sessionInfo = await query(
          `SELECT device_fingerprint FROM customer_sessions WHERE id = $1`,
          [sessionId]
        );
        const fingerprint = sessionInfo.rows[0]?.device_fingerprint || null;

        await query(
          `INSERT INTO poll_completions (poll_id, session_id, device_fingerprint)
           VALUES ($1, $2, $3)
           ON CONFLICT (poll_id, session_id) DO NOTHING`,
          [pollId, sessionId, fingerprint]
        );
      } catch (completionErr) {
        logger.error('Error recording poll completion', { error: completionErr.message });
      }
    }

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
    logger.error('Error voting on poll', { error: error.message });
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
    logger.error('Error fetching poll results', { error: error.message });
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

    // Get vendor ID for analytics tracking
    const vendorResult = await query(
      'SELECT vendor_id FROM vending_machines WHERE id = $1',
      [machineId]
    );

    // Track suggestion submit event
    if (vendorResult.rows.length > 0) {
      analyticsService.trackEvent({
        eventType: 'suggestion_submit',
        machineId,
        vendorId: vendorResult.rows[0].vendor_id,
        sessionId,
        metadata: {
          suggestionId: result.rows[0].id,
        },
      });

      // Update session activity
      analyticsService.updateSessionActivity(sessionId);
    }

    res.json({
      success: true,
      message: 'Thank you! Your suggestion has been sent to the vendor.',
      data: {
        suggestion: result.rows[0],
      },
    });
  } catch (error) {
    logger.error('Error submitting suggestion', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error submitting suggestion',
    });
  }
});

module.exports = router;
