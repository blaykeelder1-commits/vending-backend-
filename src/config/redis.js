const { Redis } = require('@upstash/redis');

let redis = null;

// Initialize Redis only if credentials are provided
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('Redis cache initialized');
} else {
  console.log('Redis cache disabled (no credentials provided)');
}

// Cache wrapper with fallback for when Redis is unavailable
const cache = {
  async get(key) {
    if (!redis) return null;
    try {
      return await redis.get(key);
    } catch (error) {
      console.error('Redis GET error:', error.message);
      return null;
    }
  },

  async set(key, value, ttlSeconds = 300) {
    if (!redis) return false;
    try {
      await redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
      return true;
    } catch (error) {
      console.error('Redis SET error:', error.message);
      return false;
    }
  },

  async del(key) {
    if (!redis) return false;
    try {
      await redis.del(key);
      return true;
    } catch (error) {
      console.error('Redis DEL error:', error.message);
      return false;
    }
  },

  async delPattern(pattern) {
    if (!redis) return false;
    try {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      return true;
    } catch (error) {
      console.error('Redis DEL pattern error:', error.message);
      return false;
    }
  },

  isEnabled() {
    return redis !== null;
  },
};

module.exports = { redis, cache };
