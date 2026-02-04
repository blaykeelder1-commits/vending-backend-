/**
 * Analytics Routes
 *
 * Provides analytics data for vendor dashboards.
 * All routes require vendor authentication.
 */

const express = require('express');
const Joi = require('joi');
const { query } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const analyticsService = require('../services/analyticsService');
const logger = require('../utils/logger');

const router = express.Router();

// Apply authentication middleware
router.use(protect);
router.use(restrictTo('vendor'));

/**
 * GET /api/analytics/overview
 * Get vendor-wide analytics overview
 */
router.get('/overview', async (req, res) => {
  try {
    const vendorId = req.user.id;
    const analytics = await analyticsService.getVendorAnalytics(vendorId);

    res.json({
      success: true,
      data: analytics,
    });
  } catch (error) {
    logger.error('Error fetching vendor analytics', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching analytics overview',
    });
  }
});

/**
 * GET /api/analytics/machines/:id
 * Get analytics for a specific machine
 */
router.get('/machines/:id', async (req, res) => {
  try {
    const vendorId = req.user.id;
    const machineId = parseInt(req.params.id);

    if (isNaN(machineId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid machine ID',
      });
    }

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, vendorId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    const analytics = await analyticsService.getMachineAnalytics(machineId, vendorId);

    res.json({
      success: true,
      data: analytics,
    });
  } catch (error) {
    logger.error('Error fetching machine analytics', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching machine analytics',
    });
  }
});

/**
 * GET /api/analytics/machines/:id/realtime
 * Get real-time hourly stats for a machine (last 24 hours)
 */
router.get('/machines/:id/realtime', async (req, res) => {
  try {
    const vendorId = req.user.id;
    const machineId = parseInt(req.params.id);

    if (isNaN(machineId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid machine ID',
      });
    }

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, vendorId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    const stats = await analyticsService.getRealTimeStats(machineId, vendorId);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Error fetching real-time stats', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching real-time statistics',
    });
  }
});

/**
 * GET /api/analytics/engagement
 * Get engagement rankings across all machines
 */
router.get('/engagement', async (req, res) => {
  try {
    const vendorId = req.user.id;
    const rankings = await analyticsService.getEngagementRankings(vendorId);

    res.json({
      success: true,
      data: rankings,
    });
  } catch (error) {
    logger.error('Error fetching engagement rankings', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching engagement rankings',
    });
  }
});

/**
 * GET /api/analytics/daily
 * Get daily analytics summary (from pre-aggregated data)
 */
router.get('/daily', async (req, res) => {
  try {
    const vendorId = req.user.id;

    const schema = Joi.object({
      days: Joi.number().integer().min(1).max(90).default(30),
    });

    const { error, value } = schema.validate(req.query);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { days } = value;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const result = await query(
      `SELECT
        date,
        SUM(qr_scans) as qr_scans,
        SUM(page_views) as page_views,
        SUM(poll_votes) as poll_votes,
        SUM(suggestions) as suggestions,
        SUM(unique_sessions) as unique_sessions
       FROM analytics_daily_machine
       WHERE vendor_id = $1 AND date >= $2
       GROUP BY date
       ORDER BY date DESC`,
      [vendorId, startDate]
    );

    res.json({
      success: true,
      data: {
        dailyStats: result.rows.map(row => ({
          date: row.date,
          qrScans: parseInt(row.qr_scans) || 0,
          pageViews: parseInt(row.page_views) || 0,
          pollVotes: parseInt(row.poll_votes) || 0,
          suggestions: parseInt(row.suggestions) || 0,
          uniqueSessions: parseInt(row.unique_sessions) || 0,
        })),
        period: `${days} days`,
      },
    });
  } catch (error) {
    logger.error('Error fetching daily analytics', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching daily analytics',
    });
  }
});

module.exports = router;
