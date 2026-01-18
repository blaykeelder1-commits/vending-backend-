const { query } = require('../config/database');

class RefreshToken {
  /**
   * Create a new refresh token
   * @param {number} userId - The user ID
   * @param {string} token - The refresh token (hashed)
   * @param {Date} expiresAt - When the token expires
   * @returns {Promise<Object>} The created refresh token record
   */
  static async create(userId, token, expiresAt) {
    const result = await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3) RETURNING *',
      [userId, token, expiresAt]
    );
    return result.rows[0];
  }

  /**
   * Find a refresh token by its token value
   * @param {string} token - The refresh token to find
   * @returns {Promise<Object|null>} The refresh token record or null
   */
  static async findByToken(token) {
    const result = await query(
      'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    return result.rows[0] || null;
  }

  /**
   * Delete a refresh token by its token value
   * @param {string} token - The refresh token to delete
   * @returns {Promise<void>}
   */
  static async deleteByToken(token) {
    await query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
  }

  /**
   * Delete all refresh tokens for a user (useful for logout from all devices)
   * @param {number} userId - The user ID
   * @returns {Promise<void>}
   */
  static async deleteAllForUser(userId) {
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  }

  /**
   * Delete expired refresh tokens (for cleanup jobs)
   * @returns {Promise<number>} The number of deleted tokens
   */
  static async deleteExpired() {
    const result = await query('DELETE FROM refresh_tokens WHERE expires_at <= NOW()');
    return result.rowCount;
  }
}

module.exports = RefreshToken;
