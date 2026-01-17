const express = require('express');
const Joi = require('joi');
const { query } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const { sendEmail } = require('../services/emailService');

const router = express.Router();

/**
 * GET /api/referral/my-code
 * Get the authenticated vendor's referral code and stats
 */
router.get('/my-code', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const userId = req.user.id;

    // Get or create referral code
    let result = await query(
      `SELECT id, code, uses_count, reward_days, is_active, created_at
       FROM referral_codes
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      // Generate new code if none exists
      const generateCode = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 8; i++) {
          code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
      };

      let newCode;
      let codeExists = true;

      while (codeExists) {
        newCode = generateCode();
        const check = await query('SELECT 1 FROM referral_codes WHERE code = $1', [newCode]);
        codeExists = check.rows.length > 0;
      }

      result = await query(
        `INSERT INTO referral_codes (user_id, code)
         VALUES ($1, $2)
         RETURNING id, code, uses_count, reward_days, is_active, created_at`,
        [userId, newCode]
      );
    }

    const referralCode = result.rows[0];

    // Get referral stats
    const statsResult = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed') as completed_referrals,
         COUNT(*) FILTER (WHERE status = 'pending') as pending_referrals,
         SUM(CASE WHEN reward_granted THEN $2 ELSE 0 END) as total_reward_days
       FROM referrals
       WHERE referrer_id = $1`,
      [userId, referralCode.reward_days]
    );

    const stats = statsResult.rows[0];

    // Get recent referrals
    const recentResult = await query(
      `SELECT r.id, r.status, r.created_at, r.completed_at,
              u.email as referred_email, u.full_name as referred_name
       FROM referrals r
       JOIN users u ON r.referred_id = u.id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC
       LIMIT 10`,
      [userId]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'https://vending-front-end.vercel.app';

    res.json({
      success: true,
      data: {
        referralCode: referralCode.code,
        referralLink: `${frontendUrl}/register?ref=${referralCode.code}`,
        stats: {
          completedReferrals: parseInt(stats.completed_referrals) || 0,
          pendingReferrals: parseInt(stats.pending_referrals) || 0,
          totalRewardDays: parseInt(stats.total_reward_days) || 0,
        },
        recentReferrals: recentResult.rows,
      },
    });
  } catch (error) {
    console.error('Error fetching referral code:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching referral information',
    });
  }
});

/**
 * POST /api/referral/validate
 * Validate a referral code (public endpoint)
 */
router.post('/validate', async (req, res) => {
  try {
    const schema = Joi.object({
      code: Joi.string().alphanum().length(8).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid referral code format',
      });
    }

    const result = await query(
      `SELECT rc.id, rc.code, rc.reward_days, u.full_name as referrer_name
       FROM referral_codes rc
       JOIN users u ON rc.user_id = u.id
       WHERE rc.code = $1
         AND rc.is_active = true
         AND (rc.max_uses IS NULL OR rc.uses_count < rc.max_uses)
         AND (rc.expires_at IS NULL OR rc.expires_at > NOW())`,
      [value.code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired referral code',
      });
    }

    const referral = result.rows[0];

    res.json({
      success: true,
      data: {
        valid: true,
        referrerName: referral.referrer_name,
        rewardDays: referral.reward_days,
      },
    });
  } catch (error) {
    console.error('Error validating referral code:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating referral code',
    });
  }
});

/**
 * POST /api/referral/invite
 * Send referral invite email
 */
router.post('/invite', protect, restrictTo('vendor'), async (req, res) => {
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

    // Get referrer's info and code
    const referrerResult = await query(
      `SELECT u.full_name, rc.code
       FROM users u
       JOIN referral_codes rc ON u.id = rc.user_id
       WHERE u.id = $1 AND rc.is_active = true
       ORDER BY rc.created_at DESC LIMIT 1`,
      [req.user.id]
    );

    if (referrerResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active referral code found',
      });
    }

    const { full_name: referrerName, code: referralCode } = referrerResult.rows[0];

    // Check if email is already registered
    const existingUser = await query(
      'SELECT 1 FROM users WHERE email = $1',
      [value.email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'This email is already registered',
      });
    }

    // Send invite email
    await sendEmail(value.email, 'referralInvite', {
      userName: referrerName,
      referralCode: referralCode,
    });

    res.json({
      success: true,
      message: 'Referral invite sent successfully',
    });
  } catch (error) {
    console.error('Error sending referral invite:', error);
    res.status(500).json({
      success: false,
      message: 'Error sending referral invite',
    });
  }
});

/**
 * GET /api/referral/leaderboard
 * Get top referrers (public stats)
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const result = await query(
      `SELECT
         u.full_name,
         COUNT(r.id) FILTER (WHERE r.status = 'completed') as referral_count
       FROM users u
       JOIN referral_codes rc ON u.id = rc.user_id
       LEFT JOIN referrals r ON r.referrer_id = u.id
       WHERE u.role = 'vendor'
       GROUP BY u.id, u.full_name
       HAVING COUNT(r.id) FILTER (WHERE r.status = 'completed') > 0
       ORDER BY referral_count DESC
       LIMIT 10`
    );

    res.json({
      success: true,
      data: {
        leaderboard: result.rows.map((row, index) => ({
          rank: index + 1,
          name: row.full_name,
          referrals: parseInt(row.referral_count),
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching leaderboard',
    });
  }
});

module.exports = router;
