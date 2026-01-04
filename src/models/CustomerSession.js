const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class CustomerSession {
  /**
   * Create a new customer session
   * @param {object} sessionData - Session data
   * @returns {object} - Created session
   */
  static async create({ customerId = null, machineId, qrCodeScanned, ipAddress, userAgent }) {
    const sessionToken = uuidv4();
    const expiresAt = new Date(Date.now() + (parseInt(process.env.SESSION_EXPIRY_HOURS) || 24) * 60 * 60 * 1000);

    const result = await query(
      `INSERT INTO customer_sessions (customer_id, machine_id, session_token, qr_code_scanned, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, customer_id, machine_id, session_token, expires_at, created_at`,
      [customerId, machineId, sessionToken, qrCodeScanned, ipAddress, userAgent, expiresAt]
    );

    return result.rows[0];
  }

  /**
   * Find session by token
   * @param {string} sessionToken - Session token
   * @returns {object|null} - Session object or null
   */
  static async findByToken(sessionToken) {
    const result = await query(
      `SELECT cs.*, u.email, u.role, u.full_name
       FROM customer_sessions cs
       LEFT JOIN users u ON cs.customer_id = u.id
       WHERE cs.session_token = $1`,
      [sessionToken]
    );

    return result.rows[0] || null;
  }

  /**
   * Check if session is valid
   * @param {string} sessionToken - Session token
   * @returns {boolean} - True if session is valid
   */
  static async isValid(sessionToken) {
    const result = await query(
      `SELECT id FROM customer_sessions
       WHERE session_token = $1 AND expires_at > NOW()`,
      [sessionToken]
    );

    return result.rows.length > 0;
  }

  /**
   * Update session with customer ID (link anonymous session to customer)
   * @param {string} sessionToken - Session token
   * @param {number} customerId - Customer ID
   * @returns {object} - Updated session
   */
  static async linkToCustomer(sessionToken, customerId) {
    const result = await query(
      `UPDATE customer_sessions
       SET customer_id = $1
       WHERE session_token = $2
       RETURNING id, customer_id, machine_id, session_token, expires_at`,
      [customerId, sessionToken]
    );

    return result.rows[0];
  }

  /**
   * Delete expired sessions (cleanup)
   * @returns {number} - Number of deleted sessions
   */
  static async deleteExpired() {
    const result = await query(
      `DELETE FROM customer_sessions WHERE expires_at < NOW()`
    );

    return result.rowCount;
  }

  /**
   * Get active sessions for a machine
   * @param {number} machineId - Machine ID
   * @returns {array} - Array of active sessions
   */
  static async getActiveSessions(machineId) {
    const result = await query(
      `SELECT cs.*, u.email, u.full_name
       FROM customer_sessions cs
       LEFT JOIN users u ON cs.customer_id = u.id
       WHERE cs.machine_id = $1 AND cs.expires_at > NOW()
       ORDER BY cs.created_at DESC`,
      [machineId]
    );

    return result.rows;
  }

  /**
   * Get session count for a customer
   * @param {number} customerId - Customer ID
   * @returns {number} - Number of active sessions
   */
  static async getCustomerSessionCount(customerId) {
    const result = await query(
      `SELECT COUNT(*) as count
       FROM customer_sessions
       WHERE customer_id = $1 AND expires_at > NOW()`,
      [customerId]
    );

    return parseInt(result.rows[0].count);
  }
}

module.exports = CustomerSession;
