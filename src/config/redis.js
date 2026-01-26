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
      // Stringify objects for storage
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      await redis.set(key, serialized, { ex: ttlSeconds });
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

/**
 * Rate limit store for express-rate-limit using Upstash Redis
 * Falls back to memory store if Redis is not configured
 */
class RedisRateLimitStore {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.prefix = 'rl:';
  }

  async increment(key) {
    if (!redis) {
      // Fallback handled by express-rate-limit's default memory store
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }

    const redisKey = this.prefix + key;
    try {
      const [[, totalHits], [, ttl]] = await redis.pipeline()
        .incr(redisKey)
        .pttl(redisKey)
        .exec();

      // Set expiry on first hit
      if (ttl === -1) {
        await redis.pexpire(redisKey, this.windowMs);
      }

      const resetTime = new Date(Date.now() + (ttl > 0 ? ttl : this.windowMs));
      return { totalHits, resetTime };
    } catch (error) {
      console.error('Redis rate limit error:', error.message);
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key) {
    if (!redis) return;
    try {
      await redis.decr(this.prefix + key);
    } catch (error) {
      console.error('Redis rate limit decrement error:', error.message);
    }
  }

  async resetKey(key) {
    if (!redis) return;
    try {
      await redis.del(this.prefix + key);
    } catch (error) {
      console.error('Redis rate limit reset error:', error.message);
    }
  }
}

/**
 * Create a rate limit store - uses Redis if available, otherwise returns undefined
 * (express-rate-limit will use its default memory store)
 */
function createRateLimitStore(windowMs) {
  if (redis) {
    return new RedisRateLimitStore(windowMs);
  }
  return undefined;
}

module.exports = { redis, cache, createRateLimitStore };
