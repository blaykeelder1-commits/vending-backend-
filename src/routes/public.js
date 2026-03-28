const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const { query } = require('../config/database');
const { createRateLimitStore } = require('../config/redis');
const logger = require('../utils/logger');

const router = express.Router();

// ========================================
// RATE LIMITERS (endpoint-specific)
// ========================================

// Lead capture: 10 requests/min per IP
const leadCaptureWindowMs = 60 * 1000;
const leadCaptureLimiter = rateLimit({
  windowMs: leadCaptureWindowMs,
  max: 10,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore(leadCaptureWindowMs),
});

// Embed poll: 30 requests/min per IP
const embedPollWindowMs = 60 * 1000;
const embedPollLimiter = rateLimit({
  windowMs: embedPollWindowMs,
  max: 30,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore(embedPollWindowMs),
});

// ========================================
// BLOG ROUTES
// ========================================

/**
 * GET /api/public/blog
 * List published blog posts
 */
router.get('/blog', async (req, res) => {
  try {
    const result = await query(
      `SELECT slug, title, meta_description, featured_image, published_at
       FROM blog_posts
       WHERE published = true
       ORDER BY published_at DESC`
    );

    res.json({
      success: true,
      data: {
        posts: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching blog posts', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching blog posts',
    });
  }
});

/**
 * GET /api/public/blog/:slug
 * Get a single published blog post
 */
router.get('/blog/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const result = await query(
      `SELECT * FROM blog_posts WHERE slug = $1 AND published = true`,
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Blog post not found',
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error('Error fetching blog post', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching blog post',
    });
  }
});

// ========================================
// SHARED REPORTS
// ========================================

/**
 * GET /api/public/report/:token
 * View a shared report (increments view_count)
 */
router.get('/report/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const result = await query(
      `SELECT data, expires_at, view_count
       FROM shared_reports
       WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Report not found or expired',
      });
    }

    // Increment view count (fire and forget)
    query(
      `UPDATE shared_reports SET view_count = view_count + 1 WHERE token = $1`,
      [token]
    ).catch(err => {
      logger.error('Error incrementing report view count', { error: err.message });
    });

    const report = result.rows[0];

    res.json({
      success: true,
      data: {
        report: report.data,
        viewCount: report.view_count + 1, // Include the current view
        expiresAt: report.expires_at,
      },
    });
  } catch (error) {
    logger.error('Error fetching shared report', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching report',
    });
  }
});

// ========================================
// LEAD CAPTURE
// ========================================

/**
 * POST /api/public/leads/capture
 * Capture an email lead with UTM params
 */
router.post('/leads/capture', leadCaptureLimiter, async (req, res) => {
  try {
    const schema = Joi.object({
      email: Joi.string().email().required(),
      source: Joi.string().max(50).optional(),
      leadMagnet: Joi.string().max(100).optional(),
      utmSource: Joi.string().max(100).optional(),
      utmMedium: Joi.string().max(100).optional(),
      utmCampaign: Joi.string().max(100).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { email, source, leadMagnet, utmSource, utmMedium, utmCampaign } = value;
    const normalizedEmail = email.toLowerCase().trim();

    // Check for duplicate email + source combo
    const existing = await query(
      `SELECT id FROM leads WHERE email = $1 AND source = $2`,
      [normalizedEmail, source || null]
    );

    if (existing.rows.length > 0) {
      return res.json({
        success: true,
        message: 'Thank you! You are already subscribed.',
        data: { duplicate: true },
      });
    }

    // Insert lead
    await query(
      `INSERT INTO leads (email, source, lead_magnet, utm_source, utm_medium, utm_campaign)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [normalizedEmail, source || null, leadMagnet || null, utmSource || null, utmMedium || null, utmCampaign || null]
    );

    // Send lead magnet delivery email if applicable (fire and forget)
    if (leadMagnet) {
      try {
        const { sendEmail } = require('../services/emailService');
        sendEmail(normalizedEmail, 'leadMagnetDelivery', { leadMagnet }).catch(err => {
          logger.error('Error sending lead magnet email', { error: err.message });
        });
      } catch (err) {
        logger.error('Error loading email service for lead magnet', { error: err.message });
      }
    }

    res.status(201).json({
      success: true,
      message: 'Thank you! Check your email for your download.',
      data: { duplicate: false },
    });
  } catch (error) {
    logger.error('Error capturing lead', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error processing your request',
    });
  }
});

// ========================================
// EMBED POLL (lightweight, for external widgets)
// ========================================

/**
 * GET /api/public/embed/poll/:machineId
 * Get active poll for a machine (lightweight, no auth)
 */
router.get('/embed/poll/:machineId', embedPollLimiter, async (req, res) => {
  try {
    const { machineId } = req.params;
    const machineIdNum = parseInt(machineId, 10);

    if (isNaN(machineIdNum)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid machine ID',
      });
    }

    // Verify machine exists and is active
    const machineResult = await query(
      `SELECT id, machine_name FROM vending_machines WHERE id = $1 AND is_active = true`,
      [machineIdNum]
    );

    if (machineResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found or inactive',
      });
    }

    // Get active poll with products
    const pollResult = await query(
      `SELECT sp.id, sp.question, sp.created_at,
              json_agg(json_build_object(
                'id', spo.id,
                'productName', p.product_name,
                'imageUrl', p.image_url
              ) ORDER BY spo.display_order) as options
       FROM swipe_polls sp
       JOIN swipe_poll_options spo ON sp.id = spo.poll_id
       JOIN products p ON spo.product_id = p.id
       WHERE sp.machine_id = $1 AND sp.is_active = true
       GROUP BY sp.id, sp.question, sp.created_at
       ORDER BY sp.created_at DESC
       LIMIT 1`,
      [machineIdNum]
    );

    if (pollResult.rows.length === 0) {
      return res.json({
        success: true,
        data: { poll: null },
      });
    }

    const poll = pollResult.rows[0];

    res.json({
      success: true,
      data: {
        poll: {
          id: poll.id,
          question: poll.question,
          options: poll.options,
          machineName: machineResult.rows[0].machine_name,
        },
      },
    });
  } catch (error) {
    logger.error('Error fetching embed poll', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching poll',
    });
  }
});

// ========================================
// REFERRAL CODE RESOLUTION
// ========================================

/**
 * GET /api/public/ref/:code
 * Resolve a referral code (returns valid/invalid + referrer first name)
 */
router.get('/ref/:code', async (req, res) => {
  try {
    const { code } = req.params;

    const result = await query(
      `SELECT id, full_name FROM users WHERE referral_code = $1`,
      [code]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: { valid: false },
      });
    }

    // Only return the first name for privacy
    const fullName = result.rows[0].full_name || '';
    const firstName = fullName.split(' ')[0];

    res.json({
      success: true,
      data: {
        valid: true,
        referrerName: firstName,
      },
    });
  } catch (error) {
    logger.error('Error resolving referral code', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error resolving referral code',
    });
  }
});

module.exports = router;
