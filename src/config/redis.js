const { Redis } = require('@upstash/redis');
const logger = require('../utils/logger');

let redis = null;

// Initialize Redis only if credentials are provided
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  logger.info('Redis cache initialized');
} else {
  logger.info('Redis cache disabled (no credentials provided)');
}

// Cache wrapper with fallback for when Redis is unavailable
const cache = {
  async get(key) {
    if (!redis) return null;
    try {
      return await redis.get(key);
    } catch (error) {
      logger.error('Redis GET error', { error: error.message });
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
      logger.error('Redis SET error', { error: error.message });
      return false;
    }
  },

  async del(key) {
    if (!redis) return false;
    try {
      await redis.del(key);
      return true;
    } catch (error) {
      logger.error('Redis DEL error', { error: error.message });
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
      logger.error('Redis DEL pattern error', { error: error.message });
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
      logger.error('Redis rate limit error', { error: error.message });
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key) {
    if (!redis) return;
    try {
      await redis.decr(this.prefix + key);
    } catch (error) {
      logger.error('Redis rate limit decrement error', { error: error.message });
    }
  }

  async resetKey(key) {
    if (!redis) return;
    try {
      await redis.del(this.prefix + key);
    } catch (error) {
      logger.error('Redis rate limit reset error', { error: error.message });
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

/**
 * Create a key generator for rate limiting that uses user ID for authenticated requests
 * and falls back to IP for unauthenticated requests.
 *
 * @param {string} prefix - Prefix for the rate limit key (e.g., 'auth', 'public')
 * @returns {function} Key generator function for express-rate-limit
 */
function createKeyGenerator(prefix = 'rl') {
  const jwt = require('jsonwebtoken');

  return (req, res) => {
    // Try to extract user ID from JWT token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.userId || decoded.id) {
          const userId = decoded.userId || decoded.id;
          return `${prefix}:user:${userId}`;
        }
      } catch (error) {
        // Token invalid or expired, fall back to IP
      }
    }

    // Check for customer session token (for customer endpoints)
    const sessionToken = req.headers['x-session-token'] || req.query.sessionToken;
    if (sessionToken) {
      return `${prefix}:session:${sessionToken}`;
    }

    // Fall back to IP address using express-rate-limit's built-in helper for IPv6 normalization
    // This prevents IPv6 users from bypassing limits
    const { ipKeyGenerator } = require('express-rate-limit');
    const ip = ipKeyGenerator(req, res);
    return `${prefix}:ip:${ip}`;
  };
}

module.exports = { redis, cache, createRateLimitStore, createKeyGenerator };
