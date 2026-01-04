const bcrypt = require('bcrypt');
const { query } = require('../config/database');

const SALT_ROUNDS = 10;

class User {
  /**
   * Create a new vendor user
   * @param {object} userData - User data
   * @returns {object} - Created user (without password)
   */
  static async createVendor({ email, password, fullName }) {
    try {
      // Hash password
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

      const result = await query(
        `INSERT INTO users (email, password_hash, role, full_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, role, full_name, created_at`,
        [email, passwordHash, 'vendor', fullName]
      );

      return result.rows[0];
    } catch (error) {
      if (error.code === '23505') {
        // Unique violation
        throw new Error('Email already exists');
      }
      throw error;
    }
  }

  /**
   * Create or get customer user
   * @param {object} userData - Customer data (optional)
   * @returns {object} - Customer user
   */
  static async createCustomer({ email = null, fullName = null } = {}) {
    try {
      const result = await query(
        `INSERT INTO users (email, role, full_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, role, full_name, created_at`,
        [email, 'customer', fullName]
      );

      return result.rows[0];
    } catch (error) {
      if (error.code === '23505' && email) {
        // If email exists, return existing customer
        return await User.findByEmail(email);
      }
      throw error;
    }
  }

  /**
   * Find user by email
   * @param {string} email - User email
   * @returns {object|null} - User object or null
   */
  static async findByEmail(email) {
    const result = await query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    return result.rows[0] || null;
  }

  /**
   * Find user by ID
   * @param {number} id - User ID
   * @returns {object|null} - User object or null
   */
  static async findById(id) {
    const result = await query(
      'SELECT id, email, role, full_name, payment_method, payment_username, created_at FROM users WHERE id = $1',
      [id]
    );

    return result.rows[0] || null;
  }

  /**
   * Verify password
   * @param {string} password - Plain text password
   * @param {string} hash - Hashed password
   * @returns {boolean} - True if password matches
   */
  static async verifyPassword(password, hash) {
    return await bcrypt.compare(password, hash);
  }

  /**
   * Update user payment information
   * @param {number} userId - User ID
   * @param {object} paymentData - Payment method and username
   * @returns {object} - Updated user
   */
  static async updatePaymentInfo(userId, { paymentMethod, paymentUsername }) {
    const result = await query(
      `UPDATE users
       SET payment_method = $1, payment_username = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, email, role, full_name, payment_method, payment_username`,
      [paymentMethod, paymentUsername, userId]
    );

    return result.rows[0];
  }

  /**
   * Update user profile
   * @param {number} userId - User ID
   * @param {object} profileData - Profile data to update
   * @returns {object} - Updated user
   */
  static async updateProfile(userId, { fullName, email }) {
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (fullName !== undefined) {
      updates.push(`full_name = $${paramCount++}`);
      values.push(fullName);
    }

    if (email !== undefined) {
      updates.push(`email = $${paramCount++}`);
      values.push(email);
    }

    if (updates.length === 0) {
      throw new Error('No fields to update');
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userId);

    const result = await query(
      `UPDATE users
       SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING id, email, role, full_name, payment_method, payment_username`,
      values
    );

    return result.rows[0];
  }
}

module.exports = User;
