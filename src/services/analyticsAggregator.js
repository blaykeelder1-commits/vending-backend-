/**
 * Analytics Aggregator Service
 *
 * Handles pre-computation of analytics summaries for efficient dashboard queries.
 * - Hourly aggregation (runs every hour via cron)
 * - Daily aggregation (runs at midnight)
 * - Weekly vendor summaries (runs weekly)
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Aggregate hourly analytics for all machines
 * Called every hour by cron job
 * Maintains a 48-hour rolling window of hourly data
 */
async function aggregateHourlyAnalytics() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get the current hour (truncated)
    const currentHour = new Date();
    currentHour.setMinutes(0, 0, 0);

    const oneHourAgo = new Date(currentHour.getTime() - 60 * 60 * 1000);
    const fortyEightHoursAgo = new Date(currentHour.getTime() - 48 * 60 * 60 * 1000);

    // Delete hourly data older than 48 hours
    const deleteResult = await client.query(
      `DELETE FROM analytics_hourly_machine WHERE hour_start < $1`,
      [fortyEightHoursAgo]
    );

    // Aggregate events from the last hour into hourly buckets
    const insertResult = await client.query(
      `INSERT INTO analytics_hourly_machine (machine_id, vendor_id, hour_start, qr_scans, page_views, poll_views, poll_votes, suggestions, unique_sessions)
       SELECT
         ae.machine_id,
         ae.vendor_id,
         DATE_TRUNC('hour', ae.created_at) as hour_start,
         COUNT(*) FILTER (WHERE ae.event_type = 'qr_scan') as qr_scans,
         COUNT(*) FILTER (WHERE ae.event_type = 'page_view') as page_views,
         COUNT(*) FILTER (WHERE ae.event_type = 'poll_view') as poll_views,
         COUNT(*) FILTER (WHERE ae.event_type = 'poll_vote') as poll_votes,
         COUNT(*) FILTER (WHERE ae.event_type = 'suggestion_submit') as suggestions,
         COUNT(DISTINCT ae.session_id) as unique_sessions
       FROM analytics_events ae
       WHERE ae.created_at >= $1 AND ae.created_at < $2
         AND ae.machine_id IS NOT NULL
         AND ae.vendor_id IS NOT NULL
       GROUP BY ae.machine_id, ae.vendor_id, DATE_TRUNC('hour', ae.created_at)
       ON CONFLICT (machine_id, hour_start)
       DO UPDATE SET
         qr_scans = EXCLUDED.qr_scans,
         page_views = EXCLUDED.page_views,
         poll_views = EXCLUDED.poll_views,
         poll_votes = EXCLUDED.poll_votes,
         suggestions = EXCLUDED.suggestions,
         unique_sessions = EXCLUDED.unique_sessions`,
      [oneHourAgo, currentHour]
    );

    await client.query('COMMIT');

    return {
      success: true,
      deletedOldRecords: deleteResult.rowCount,
      aggregatedRecords: insertResult.rowCount,
      hourProcessed: oneHourAgo.toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error in hourly aggregation', { error: error.message });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Aggregate daily analytics for all machines
 * Called at midnight by cron job
 */
async function aggregateDailyAnalytics() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get yesterday's date
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Aggregate yesterday's events into daily buckets
    const insertResult = await client.query(
      `INSERT INTO analytics_daily_machine (machine_id, vendor_id, date, qr_scans, page_views, poll_views, poll_votes, suggestions, unique_sessions, avg_session_duration_seconds)
       SELECT
         ae.machine_id,
         ae.vendor_id,
         DATE(ae.created_at) as date,
         COUNT(*) FILTER (WHERE ae.event_type = 'qr_scan') as qr_scans,
         COUNT(*) FILTER (WHERE ae.event_type = 'page_view') as page_views,
         COUNT(*) FILTER (WHERE ae.event_type = 'poll_view') as poll_views,
         COUNT(*) FILTER (WHERE ae.event_type = 'poll_vote') as poll_votes,
         COUNT(*) FILTER (WHERE ae.event_type = 'suggestion_submit') as suggestions,
         COUNT(DISTINCT ae.session_id) as unique_sessions,
         COALESCE(
           (SELECT AVG(cs.duration_seconds)::INTEGER
            FROM customer_sessions cs
            WHERE cs.machine_id = ae.machine_id
              AND DATE(cs.created_at) = DATE(ae.created_at)
              AND cs.duration_seconds > 0),
           0
         ) as avg_session_duration_seconds
       FROM analytics_events ae
       WHERE DATE(ae.created_at) = $1
         AND ae.machine_id IS NOT NULL
         AND ae.vendor_id IS NOT NULL
       GROUP BY ae.machine_id, ae.vendor_id, DATE(ae.created_at)
       ON CONFLICT (machine_id, date)
       DO UPDATE SET
         qr_scans = EXCLUDED.qr_scans,
         page_views = EXCLUDED.page_views,
         poll_views = EXCLUDED.poll_views,
         poll_votes = EXCLUDED.poll_votes,
         suggestions = EXCLUDED.suggestions,
         unique_sessions = EXCLUDED.unique_sessions,
         avg_session_duration_seconds = EXCLUDED.avg_session_duration_seconds,
         updated_at = NOW()`,
      [yesterday]
    );

    await client.query('COMMIT');

    return {
      success: true,
      aggregatedRecords: insertResult.rowCount,
      dateProcessed: yesterday.toISOString().split('T')[0],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error in daily aggregation', { error: error.message });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Aggregate weekly vendor summaries
 * Called weekly by cron job
 */
async function aggregateWeeklyVendorAnalytics() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get last week's start date (Monday)
    const today = new Date();
    const dayOfWeek = today.getDay();
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const lastMonday = new Date(today);
    lastMonday.setDate(today.getDate() - diffToMonday - 7);
    lastMonday.setHours(0, 0, 0, 0);

    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 7);

    // Aggregate last week's data per vendor
    const insertResult = await client.query(
      `INSERT INTO analytics_vendor_weekly (vendor_id, week_start, total_qr_scans, total_page_views, total_poll_votes, total_suggestions, total_unique_sessions, active_machines, engagement_score, top_machine_id)
       SELECT
         ae.vendor_id,
         $1::DATE as week_start,
         COUNT(*) FILTER (WHERE ae.event_type = 'qr_scan') as total_qr_scans,
         COUNT(*) FILTER (WHERE ae.event_type = 'page_view') as total_page_views,
         COUNT(*) FILTER (WHERE ae.event_type = 'poll_vote') as total_poll_votes,
         COUNT(*) FILTER (WHERE ae.event_type = 'suggestion_submit') as total_suggestions,
         COUNT(DISTINCT ae.session_id) as total_unique_sessions,
         COUNT(DISTINCT ae.machine_id) as active_machines,
         (
           COUNT(*) FILTER (WHERE ae.event_type = 'qr_scan') * 1 +
           COUNT(*) FILTER (WHERE ae.event_type = 'poll_vote') * 3 +
           COUNT(*) FILTER (WHERE ae.event_type = 'suggestion_submit') * 5
         ) as engagement_score,
         (
           SELECT machine_id
           FROM analytics_events ae2
           WHERE ae2.vendor_id = ae.vendor_id
             AND ae2.created_at >= $1 AND ae2.created_at < $2
           GROUP BY ae2.machine_id
           ORDER BY COUNT(*) DESC
           LIMIT 1
         ) as top_machine_id
       FROM analytics_events ae
       WHERE ae.created_at >= $1 AND ae.created_at < $2
         AND ae.vendor_id IS NOT NULL
       GROUP BY ae.vendor_id
       ON CONFLICT (vendor_id, week_start)
       DO UPDATE SET
         total_qr_scans = EXCLUDED.total_qr_scans,
         total_page_views = EXCLUDED.total_page_views,
         total_poll_votes = EXCLUDED.total_poll_votes,
         total_suggestions = EXCLUDED.total_suggestions,
         total_unique_sessions = EXCLUDED.total_unique_sessions,
         active_machines = EXCLUDED.active_machines,
         engagement_score = EXCLUDED.engagement_score,
         top_machine_id = EXCLUDED.top_machine_id,
         updated_at = NOW()`,
      [lastMonday, lastSunday]
    );

    await client.query('COMMIT');

    return {
      success: true,
      aggregatedVendors: insertResult.rowCount,
      weekProcessed: lastMonday.toISOString().split('T')[0],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error in weekly aggregation', { error: error.message });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Clean up old analytics events (keep 90 days of raw events)
 * Raw events older than 90 days are preserved in aggregate tables
 */
async function cleanupOldEvents() {
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `DELETE FROM analytics_events WHERE created_at < $1`,
      [ninetyDaysAgo]
    );

    return {
      success: true,
      deletedEvents: result.rowCount,
    };
  } catch (error) {
    logger.error('Error cleaning up old events', { error: error.message });
    throw error;
  }
}

module.exports = {
  aggregateHourlyAnalytics,
  aggregateDailyAnalytics,
  aggregateWeeklyVendorAnalytics,
  cleanupOldEvents,
};
