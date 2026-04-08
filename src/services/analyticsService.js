/**
 * Analytics Service
 *
 * Handles tracking and retrieval of analytics events.
 * - Event buffering for batch inserts (reduces DB load)
 * - Machine and vendor analytics with caching
 * - Real-time stats for dashboards
 */

const { query } = require('../config/database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

// Event buffer for batch inserts
const eventBuffer = [];
const BUFFER_SIZE = 50;
const MAX_BUFFER_SIZE = 500; // Hard cap to prevent OOM if DB is down
const BUFFER_FLUSH_INTERVAL = 10000; // 10 seconds

// Valid event types
const EVENT_TYPES = {
  QR_SCAN: 'qr_scan',
  PAGE_VIEW: 'page_view',
  POLL_VIEW: 'poll_view',
  POLL_VOTE: 'poll_vote',
  SUGGESTION_SUBMIT: 'suggestion_submit',
};

/**
 * Track an analytics event
 * Events are buffered and batch-inserted for performance
 */
async function trackEvent({
  eventType,
  machineId,
  vendorId,
  sessionId = null,
  metadata = {},
  ipAddress = null,
  userAgent = null,
}) {
  if (!EVENT_TYPES[eventType.toUpperCase().replace('-', '_')] && !Object.values(EVENT_TYPES).includes(eventType)) {
    logger.warn('Invalid event type', { eventType });
    return;
  }

  const event = {
    event_type: eventType,
    machine_id: machineId,
    vendor_id: vendorId,
    session_id: sessionId,
    metadata: JSON.stringify(metadata),
    ip_address: ipAddress,
    user_agent: userAgent,
    created_at: new Date(),
  };

  // Drop oldest events if buffer exceeds hard cap (DB likely down)
  if (eventBuffer.length >= MAX_BUFFER_SIZE) {
    const dropped = eventBuffer.splice(0, eventBuffer.length - MAX_BUFFER_SIZE + 1);
    logger.warn('Analytics buffer overflow — dropped oldest events', { droppedCount: dropped.length });
  }

  eventBuffer.push(event);

  // Flush if buffer is full
  if (eventBuffer.length >= BUFFER_SIZE) {
    await flushEventBuffer();
  }
}

/**
 * Flush event buffer to database
 */
async function flushEventBuffer() {
  if (eventBuffer.length === 0) return;

  const eventsToInsert = eventBuffer.splice(0, eventBuffer.length);

  try {
    // Build batch insert query
    const values = [];
    const placeholders = eventsToInsert.map((event, idx) => {
      const base = idx * 7;
      values.push(
        event.event_type,
        event.machine_id,
        event.vendor_id,
        event.session_id,
        event.metadata,
        event.ip_address,
        event.user_agent
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });

    await query(
      `INSERT INTO analytics_events (event_type, machine_id, vendor_id, session_id, metadata, ip_address, user_agent)
       VALUES ${placeholders.join(', ')}`,
      values
    );

    logger.debug('Flushed analytics events', { count: eventsToInsert.length });
  } catch (error) {
    logger.error('Error flushing event buffer', { error: error.message });
    // Re-add events to buffer on failure (for retry)
    eventBuffer.unshift(...eventsToInsert);
  }
}

// Start periodic buffer flush
setInterval(flushEventBuffer, BUFFER_FLUSH_INTERVAL);

/**
 * Get analytics overview for a vendor
 * Includes totals, today's stats, and week comparison
 */
async function getVendorAnalytics(vendorId) {
  const cacheKey = `analytics:vendor:${vendorId}`;

  // Check cache first (5 minute TTL)
  const cached = await cache.get(cacheKey);
  if (cached) {
    return typeof cached === 'string' ? JSON.parse(cached) : cached;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

  try {
    // Get today's stats
    const todayResult = await query(
      `SELECT
        COUNT(*) FILTER (WHERE event_type = 'qr_scan') as qr_scans,
        COUNT(*) FILTER (WHERE event_type = 'page_view') as page_views,
        COUNT(*) FILTER (WHERE event_type = 'poll_vote') as poll_votes,
        COUNT(*) FILTER (WHERE event_type = 'suggestion_submit') as suggestions,
        COUNT(DISTINCT session_id) as unique_sessions
       FROM analytics_events
       WHERE vendor_id = $1 AND created_at >= $2`,
      [vendorId, today]
    );

    // Get this week's stats
    const thisWeekResult = await query(
      `SELECT
        COUNT(*) FILTER (WHERE event_type = 'qr_scan') as qr_scans,
        COUNT(*) FILTER (WHERE event_type = 'page_view') as page_views,
        COUNT(*) FILTER (WHERE event_type = 'poll_vote') as poll_votes,
        COUNT(*) FILTER (WHERE event_type = 'suggestion_submit') as suggestions,
        COUNT(DISTINCT session_id) as unique_sessions
       FROM analytics_events
       WHERE vendor_id = $1 AND created_at >= $2`,
      [vendorId, weekAgo]
    );

    // Get last week's stats (for comparison)
    const lastWeekResult = await query(
      `SELECT
        COUNT(*) FILTER (WHERE event_type = 'qr_scan') as qr_scans,
        COUNT(*) FILTER (WHERE event_type = 'poll_vote') as poll_votes,
        COUNT(DISTINCT session_id) as unique_sessions
       FROM analytics_events
       WHERE vendor_id = $1 AND created_at >= $2 AND created_at < $3`,
      [vendorId, twoWeeksAgo, weekAgo]
    );

    // Get machine breakdown
    const machineBreakdown = await query(
      `SELECT
        ae.machine_id,
        vm.machine_name,
        COUNT(*) FILTER (WHERE ae.event_type = 'qr_scan') as qr_scans,
        COUNT(*) FILTER (WHERE ae.event_type = 'poll_vote') as poll_votes,
        COUNT(DISTINCT ae.session_id) as unique_sessions
       FROM analytics_events ae
       JOIN vending_machines vm ON ae.machine_id = vm.id
       WHERE ae.vendor_id = $1 AND ae.created_at >= $2
       GROUP BY ae.machine_id, vm.machine_name
       ORDER BY qr_scans DESC
       LIMIT 10`,
      [vendorId, weekAgo]
    );

    const todayStats = todayResult.rows[0];
    const thisWeekStats = thisWeekResult.rows[0];
    const lastWeekStats = lastWeekResult.rows[0];

    // Calculate week-over-week change
    const calcChange = (current, previous) => {
      if (!previous || previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    const analytics = {
      today: {
        qrScans: parseInt(todayStats.qr_scans) || 0,
        pageViews: parseInt(todayStats.page_views) || 0,
        pollVotes: parseInt(todayStats.poll_votes) || 0,
        suggestions: parseInt(todayStats.suggestions) || 0,
        uniqueSessions: parseInt(todayStats.unique_sessions) || 0,
      },
      thisWeek: {
        qrScans: parseInt(thisWeekStats.qr_scans) || 0,
        pageViews: parseInt(thisWeekStats.page_views) || 0,
        pollVotes: parseInt(thisWeekStats.poll_votes) || 0,
        suggestions: parseInt(thisWeekStats.suggestions) || 0,
        uniqueSessions: parseInt(thisWeekStats.unique_sessions) || 0,
      },
      weekOverWeek: {
        qrScansChange: calcChange(
          parseInt(thisWeekStats.qr_scans) || 0,
          parseInt(lastWeekStats.qr_scans) || 0
        ),
        pollVotesChange: calcChange(
          parseInt(thisWeekStats.poll_votes) || 0,
          parseInt(lastWeekStats.poll_votes) || 0
        ),
        sessionsChange: calcChange(
          parseInt(thisWeekStats.unique_sessions) || 0,
          parseInt(lastWeekStats.unique_sessions) || 0
        ),
      },
      topMachines: machineBreakdown.rows.map(row => ({
        machineId: row.machine_id,
        machineName: row.machine_name,
        qrScans: parseInt(row.qr_scans) || 0,
        pollVotes: parseInt(row.poll_votes) || 0,
        uniqueSessions: parseInt(row.unique_sessions) || 0,
      })),
      lastUpdated: new Date().toISOString(),
    };

    // Cache for 5 minutes
    await cache.set(cacheKey, analytics, 300);

    return analytics;
  } catch (error) {
    logger.error('Error getting vendor analytics', { error: error.message });
    throw error;
  }
}

/**
 * Get analytics for a specific machine
 */
async function getMachineAnalytics(machineId, vendorId) {
  const cacheKey = `analytics:machine:${machineId}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    return typeof cached === 'string' ? JSON.parse(cached) : cached;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  try {
    // Get overall stats for this machine
    const overallResult = await query(
      `SELECT
        COUNT(*) FILTER (WHERE event_type = 'qr_scan') as total_qr_scans,
        COUNT(*) FILTER (WHERE event_type = 'page_view') as total_page_views,
        COUNT(*) FILTER (WHERE event_type = 'poll_vote') as total_poll_votes,
        COUNT(*) FILTER (WHERE event_type = 'suggestion_submit') as total_suggestions,
        COUNT(DISTINCT session_id) as total_sessions
       FROM analytics_events
       WHERE machine_id = $1 AND vendor_id = $2`,
      [machineId, vendorId]
    );

    // Get last 30 days daily breakdown
    const dailyResult = await query(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) FILTER (WHERE event_type = 'qr_scan') as qr_scans,
        COUNT(*) FILTER (WHERE event_type = 'poll_vote') as poll_votes,
        COUNT(DISTINCT session_id) as sessions
       FROM analytics_events
       WHERE machine_id = $1 AND vendor_id = $2 AND created_at >= $3
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [machineId, vendorId, thirtyDaysAgo]
    );

    // Get average session duration
    const sessionResult = await query(
      `SELECT
        AVG(duration_seconds) as avg_duration,
        AVG(page_views) as avg_page_views
       FROM customer_sessions
       WHERE machine_id = $1 AND duration_seconds > 0`,
      [machineId]
    );

    const overall = overallResult.rows[0];
    const sessionStats = sessionResult.rows[0];

    const analytics = {
      overall: {
        totalQrScans: parseInt(overall.total_qr_scans) || 0,
        totalPageViews: parseInt(overall.total_page_views) || 0,
        totalPollVotes: parseInt(overall.total_poll_votes) || 0,
        totalSuggestions: parseInt(overall.total_suggestions) || 0,
        totalSessions: parseInt(overall.total_sessions) || 0,
      },
      dailyStats: dailyResult.rows.map(row => ({
        date: row.date,
        qrScans: parseInt(row.qr_scans) || 0,
        pollVotes: parseInt(row.poll_votes) || 0,
        sessions: parseInt(row.sessions) || 0,
      })),
      sessionMetrics: {
        avgDurationSeconds: Math.round(parseFloat(sessionStats.avg_duration) || 0),
        avgPageViews: Math.round(parseFloat(sessionStats.avg_page_views) || 0),
      },
      lastUpdated: new Date().toISOString(),
    };

    // Cache for 5 minutes
    await cache.set(cacheKey, analytics, 300);

    return analytics;
  } catch (error) {
    logger.error('Error getting machine analytics', { error: error.message });
    throw error;
  }
}

/**
 * Get real-time stats (hourly data for last 24 hours)
 */
async function getRealTimeStats(machineId, vendorId) {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  try {
    const result = await query(
      `SELECT
        DATE_TRUNC('hour', created_at) as hour,
        COUNT(*) FILTER (WHERE event_type = 'qr_scan') as qr_scans,
        COUNT(*) FILTER (WHERE event_type = 'poll_vote') as poll_votes,
        COUNT(DISTINCT session_id) as sessions
       FROM analytics_events
       WHERE machine_id = $1 AND vendor_id = $2 AND created_at >= $3
       GROUP BY DATE_TRUNC('hour', created_at)
       ORDER BY hour DESC`,
      [machineId, vendorId, twentyFourHoursAgo]
    );

    return {
      hourlyStats: result.rows.map(row => ({
        hour: row.hour,
        qrScans: parseInt(row.qr_scans) || 0,
        pollVotes: parseInt(row.poll_votes) || 0,
        sessions: parseInt(row.sessions) || 0,
      })),
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Error getting real-time stats', { error: error.message });
    throw error;
  }
}

/**
 * Get engagement rankings across all machines for a vendor
 */
async function getEngagementRankings(vendorId) {
  const cacheKey = `analytics:engagement:${vendorId}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    return typeof cached === 'string' ? JSON.parse(cached) : cached;
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  try {
    const result = await query(
      `SELECT
        ae.machine_id,
        vm.machine_name,
        vm.location,
        COUNT(*) FILTER (WHERE ae.event_type = 'qr_scan') as qr_scans,
        COUNT(*) FILTER (WHERE ae.event_type = 'poll_vote') as poll_votes,
        COUNT(*) FILTER (WHERE ae.event_type = 'suggestion_submit') as suggestions,
        COUNT(DISTINCT ae.session_id) as unique_sessions,
        (
          COUNT(*) FILTER (WHERE ae.event_type = 'qr_scan') * 1 +
          COUNT(*) FILTER (WHERE ae.event_type = 'poll_vote') * 3 +
          COUNT(*) FILTER (WHERE ae.event_type = 'suggestion_submit') * 5
        ) as engagement_score
       FROM analytics_events ae
       JOIN vending_machines vm ON ae.machine_id = vm.id
       WHERE ae.vendor_id = $1 AND ae.created_at >= $2 AND vm.is_active = true
       GROUP BY ae.machine_id, vm.machine_name, vm.location
       ORDER BY engagement_score DESC`,
      [vendorId, thirtyDaysAgo]
    );

    const rankings = {
      machines: result.rows.map((row, index) => ({
        rank: index + 1,
        machineId: row.machine_id,
        machineName: row.machine_name,
        location: row.location,
        qrScans: parseInt(row.qr_scans) || 0,
        pollVotes: parseInt(row.poll_votes) || 0,
        suggestions: parseInt(row.suggestions) || 0,
        uniqueSessions: parseInt(row.unique_sessions) || 0,
        engagementScore: parseInt(row.engagement_score) || 0,
      })),
      lastUpdated: new Date().toISOString(),
    };

    // Cache for 5 minutes
    await cache.set(cacheKey, rankings, 300);

    return rankings;
  } catch (error) {
    logger.error('Error getting engagement rankings', { error: error.message });
    throw error;
  }
}

/**
 * Update session activity (for page view tracking)
 */
async function updateSessionActivity(sessionId) {
  try {
    await query(
      `UPDATE customer_sessions
       SET last_activity_at = NOW(),
           page_views = COALESCE(page_views, 0) + 1
       WHERE id = $1`,
      [sessionId]
    );
  } catch (error) {
    logger.error('Error updating session activity', { error: error.message });
  }
}

module.exports = {
  EVENT_TYPES,
  trackEvent,
  flushEventBuffer,
  getVendorAnalytics,
  getMachineAnalytics,
  getRealTimeStats,
  getEngagementRankings,
  updateSessionActivity,
};
