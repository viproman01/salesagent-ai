import { Request, Response, NextFunction } from 'express';
import { getRedisConnection } from '../utils/redis';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  message?: string;
}

export function createRateLimiter(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const redis = getRedisConnection();
    const key = `ratelimit:${req.ip}:${req.path}`;
    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, Math.ceil(config.windowMs / 1000));
    }

    res.set('X-RateLimit-Limit', config.maxRequests.toString());
    res.set('X-RateLimit-Remaining', Math.max(0, config.maxRequests - current).toString());

    if (current > config.maxRequests) {
      return res.status(429).json({
        error: config.message || 'Too many requests, please try again later'
      });
    }

    return next();
  };
}

export const chatLimit = createRateLimiter({
  windowMs: 60000,
  maxRequests: 10
});

export const apiLimit = createRateLimiter({
  windowMs: 60000,
  maxRequests: 30
});

export const webhookLimit = createRateLimiter({
  windowMs: 60000,
  maxRequests: 100
});
