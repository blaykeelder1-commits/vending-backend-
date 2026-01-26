/**
 * Ranking Service - Top 50 Products Learning Algorithm
 *
 * Calculates weighted rankings for products based on:
 * - Yes count (total "performing" votes) - weight: 10
 * - Performance percentage (yes/total ratio) - weight: 5
 * - Vendor diversity bonus (unique vendors rating) - weight: 3
 *
 * Rankings are cached in product_rankings table and recalculated hourly.
 */

const { pool } = require('../config/database');

/**
 * Calculate ranking score using weighted formula
 * Score = (yes_count * 10) + (performance_percentage * 5) + (unique_vendors * 3)
 */
function calculateRankingScore(yesCount, performancePercentage, uniqueVendors) {
  return (yesCount * 10) + (performancePercentage * 5) + (uniqueVendors * 3);
}

/**
 * Recalculate all product rankings and update the cache table
 * This runs hourly via cron job
 */
async function recalculateAllRankings() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Clear existing rankings
    await client.query('DELETE FROM product_rankings');

    // Calculate and insert new rankings
    const result = await client.query(`
      INSERT INTO product_rankings (product_id, ranking_score, rank_position, yes_count, no_count, unique_vendors, calculated_at)
      SELECT
        p.id as product_id,
        (
          (COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 10) +
          (COALESCE(
            COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 100.0 /
            NULLIF(COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END), 0),
            0
          ) * 5) +
          (COUNT(DISTINCT vm.vendor_id) * 3)
        ) as ranking_score,
        ROW_NUMBER() OVER (ORDER BY
          (COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 10) +
          (COALESCE(
            COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 100.0 /
            NULLIF(COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END), 0),
            0
          ) * 5) +
          (COUNT(DISTINCT vm.vendor_id) * 3)
        DESC) as rank_position,
        COUNT(CASE WHEN mp.is_performing = true THEN 1 END) as yes_count,
        COUNT(CASE WHEN mp.is_performing = false THEN 1 END) as no_count,
        COUNT(DISTINCT vm.vendor_id) as unique_vendors,
        NOW() as calculated_at
      FROM products p
      JOIN machine_products mp ON p.id = mp.product_id
      JOIN vending_machines vm ON mp.machine_id = vm.id
      WHERE mp.is_performing IS NOT NULL
      GROUP BY p.id
      HAVING COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END) >= 1
      ORDER BY ranking_score DESC
      LIMIT 50
    `);

    await client.query('COMMIT');

    return {
      success: true,
      productsRanked: result.rowCount,
      calculatedAt: new Date()
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[RankingService] Error recalculating rankings:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get cached top products from rankings table
 * Falls back to live calculation if cache is empty
 */
async function getTopProducts(limit = 50) {
  try {
    // Try to get from cache first
    const cachedResult = await pool.query(`
      SELECT
        pr.product_id,
        p.product_name,
        p.image_url,
        pr.ranking_score,
        pr.rank_position,
        pr.yes_count,
        pr.no_count,
        pr.unique_vendors,
        pr.calculated_at,
        COUNT(mp.id) as total_machines,
        ROUND(
          pr.yes_count * 100.0 / NULLIF(pr.yes_count + pr.no_count, 0),
          1
        ) as performance_percentage
      FROM product_rankings pr
      JOIN products p ON pr.product_id = p.id
      LEFT JOIN machine_products mp ON p.id = mp.product_id
      GROUP BY pr.product_id, p.product_name, p.image_url,
               pr.ranking_score, pr.rank_position, pr.yes_count,
               pr.no_count, pr.unique_vendors, pr.calculated_at
      ORDER BY pr.rank_position ASC
      LIMIT $1
    `, [limit]);

    if (cachedResult.rows.length > 0) {
      return {
        products: cachedResult.rows,
        lastUpdated: cachedResult.rows[0]?.calculated_at || null,
        fromCache: true
      };
    }

    // Fallback to live calculation if cache is empty
    return await getLiveTopProducts(limit);
  } catch (error) {
    console.error('[RankingService] Error getting top products:', error);
    // Fallback to live calculation on error
    return await getLiveTopProducts(limit);
  }
}

/**
 * Live calculation of top products (fallback when cache is empty)
 */
async function getLiveTopProducts(limit = 50) {
  const result = await pool.query(`
    SELECT
      p.id as product_id,
      p.product_name,
      p.image_url,
      (
        (COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 10) +
        (COALESCE(
          COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 100.0 /
          NULLIF(COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END), 0),
          0
        ) * 5) +
        (COUNT(DISTINCT vm.vendor_id) * 3)
      ) as ranking_score,
      ROW_NUMBER() OVER (ORDER BY
        (COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 10) +
        (COALESCE(
          COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 100.0 /
          NULLIF(COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END), 0),
          0
        ) * 5) +
        (COUNT(DISTINCT vm.vendor_id) * 3)
      DESC) as rank_position,
      COUNT(CASE WHEN mp.is_performing = true THEN 1 END) as yes_count,
      COUNT(CASE WHEN mp.is_performing = false THEN 1 END) as no_count,
      COUNT(DISTINCT vm.vendor_id) as unique_vendors,
      COUNT(mp.id) as total_machines,
      ROUND(
        COUNT(CASE WHEN mp.is_performing = true THEN 1 END) * 100.0 /
        NULLIF(COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END), 0),
        1
      ) as performance_percentage
    FROM products p
    JOIN machine_products mp ON p.id = mp.product_id
    JOIN vending_machines vm ON mp.machine_id = vm.id
    WHERE mp.is_performing IS NOT NULL
    GROUP BY p.id, p.product_name, p.image_url
    HAVING COUNT(CASE WHEN mp.is_performing IS NOT NULL THEN 1 END) >= 1
    ORDER BY ranking_score DESC
    LIMIT $1
  `, [limit]);

  return {
    products: result.rows,
    lastUpdated: null,
    fromCache: false
  };
}

/**
 * Check if rankings cache is stale (older than 2 hours)
 */
async function isCacheStale() {
  const result = await pool.query(`
    SELECT calculated_at
    FROM product_rankings
    ORDER BY calculated_at DESC
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    return true;
  }

  const calculatedAt = new Date(result.rows[0].calculated_at);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

  return calculatedAt < twoHoursAgo;
}

module.exports = {
  recalculateAllRankings,
  getTopProducts,
  getLiveTopProducts,
  calculateRankingScore,
  isCacheStale
};
