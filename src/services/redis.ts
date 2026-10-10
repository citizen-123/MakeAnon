import Redis from 'ioredis';
import crypto from 'crypto';
import logger from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_PREFIX = process.env.REDIS_PREFIX || 'emask:';

let redis: Redis | null = null;
let isConnected = false;

export function getRedisClient(): Redis | null {
  if (!redis) {
    try {
      redis = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        lazyConnect: true,
      });

      redis.on('connect', () => {
        isConnected = true;
        logger.info('Redis connected');
      });

      redis.on('error', (err) => {
        isConnected = false;
        logger.error('Redis error:', err.message);
      });

      redis.on('close', () => {
        isConnected = false;
        logger.warn('Redis connection closed');
      });
    } catch (error) {
      logger.error('Failed to create Redis client:', error);
      return null;
    }
  }
  return redis;
}

export async function connectRedis(): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    await client.connect();
    return true;
  } catch (error) {
    logger.error('Failed to connect to Redis:', error);
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    isConnected = false;
  }
}

export function isRedisConnected(): boolean {
  return isConnected;
}

// Key builders
function key(suffix: string): string {
  return `${REDIS_PREFIX}${suffix}`;
}

// ============================================================================
// Caching Functions
// ============================================================================

export async function cacheGet<T>(cacheKey: string): Promise<T | null> {
  if (!redis || !isConnected) return null;

  try {
    const data = await redis.get(key(cacheKey));
    return data ? JSON.parse(data) : null;
  } catch (error) {
    logger.error('Cache get error:', error);
    return null;
  }
}

export async function cacheSet(
  cacheKey: string,
  value: unknown,
  ttlSeconds = 300
): Promise<boolean> {
  if (!redis || !isConnected) return false;

  try {
    await redis.setex(key(cacheKey), ttlSeconds, JSON.stringify(value));
    return true;
  } catch (error) {
    logger.error('Cache set error:', error);
    return false;
  }
}

export async function cacheDelete(cacheKey: string): Promise<boolean> {
  if (!redis || !isConnected) return false;

  try {
    await redis.del(key(cacheKey));
    return true;
  } catch (error) {
    logger.error('Cache delete error:', error);
    return false;
  }
}

export async function cacheDeletePattern(pattern: string): Promise<boolean> {
  if (!redis || !isConnected) return false;

  try {
    const keys = await redis.keys(key(pattern));
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    return true;
  } catch (error) {
    logger.error('Cache delete pattern error:', error);
    return false;
  }
}

// ============================================================================
// Rate Limiting Functions
// ============================================================================

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export async function checkRateLimit(
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const resetAt = new Date(Date.now() + windowSeconds * 1000);

  if (!redis || !isConnected) {
    // If Redis is unavailable, fail open (allow the request) but make it visible
    logger.warn('Rate limiting unavailable - Redis not connected, failing open');
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  const hashedId = crypto.createHash('sha256').update(identifier).digest('hex').substring(0, 32);
  const rateLimitKey = key(`ratelimit:${hashedId}`);

  try {
    // INCR + EXPIRE NX + TTL in one MULTI so the counter can never be left
    // without a TTL (EXPIRE NX only sets the expiry if none exists yet).
    const results = await redis
      .multi()
      .incr(rateLimitKey)
      .expire(rateLimitKey, windowSeconds, 'NX')
      .ttl(rateLimitKey)
      .exec();

    if (!results || results.some(([err]) => err)) {
      logger.warn('Rate limit transaction failed - failing open');
      return { allowed: true, remaining: limit - 1, resetAt };
    }

    const count = results[0][1] as number;
    const ttl = results[2][1] as number;

    const remaining = Math.max(0, limit - count);
    const actualResetAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : resetAt;

    return {
      allowed: count <= limit,
      remaining,
      resetAt: actualResetAt,
    };
  } catch (error) {
    logger.warn('Rate limit check error - failing open:', error);
    return { allowed: true, remaining: limit - 1, resetAt };
  }
}

// ============================================================================
// Delivery De-duplication (for SMTP retries after partial failures)
// ============================================================================

const DELIVERY_RECORD_TTL = 24 * 60 * 60; // 24 hours

function deliveryKey(deliveryId: string): string {
  const hashed = crypto.createHash('sha256').update(deliveryId).digest('hex');
  return key(`delivered:${hashed}`);
}

/**
 * Check whether a (message, recipient) delivery was already recorded.
 * Returns false when Redis is unavailable (prefer a duplicate over a lost message).
 */
export async function isDeliveryRecorded(deliveryId: string): Promise<boolean> {
  if (!redis || !isConnected) return false;

  try {
    return (await redis.exists(deliveryKey(deliveryId))) === 1;
  } catch (error) {
    logger.warn('Delivery record lookup error:', error);
    return false;
  }
}

/**
 * Record a successful (message, recipient) delivery (SET NX with TTL).
 */
export async function recordDelivery(
  deliveryId: string,
  ttlSeconds = DELIVERY_RECORD_TTL
): Promise<boolean> {
  if (!redis || !isConnected) return false;

  try {
    const result = await redis.set(deliveryKey(deliveryId), '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (error) {
    logger.warn('Delivery record store error:', error);
    return false;
  }
}

// ============================================================================
// Session/Token Functions
// ============================================================================

export async function storeToken(
  tokenKey: string,
  data: unknown,
  ttlSeconds: number
): Promise<boolean> {
  return cacheSet(`token:${tokenKey}`, data, ttlSeconds);
}

export async function getToken<T>(tokenKey: string): Promise<T | null> {
  return cacheGet<T>(`token:${tokenKey}`);
}

export async function deleteToken(tokenKey: string): Promise<boolean> {
  return cacheDelete(`token:${tokenKey}`);
}

// ============================================================================
// Alias Lookup Cache
// ============================================================================

export async function cacheAlias(alias: string, data: unknown): Promise<void> {
  await cacheSet(`alias:${alias.toLowerCase()}`, data, 60); // 1 minute cache
}

export async function getCachedAlias<T>(alias: string): Promise<T | null> {
  return cacheGet<T>(`alias:${alias.toLowerCase()}`);
}

export async function invalidateAliasCache(alias: string): Promise<void> {
  await cacheDelete(`alias:${alias.toLowerCase()}`);
}

// ============================================================================
// Domain Cache
// ============================================================================

export async function cacheDomains(domains: unknown[]): Promise<void> {
  await cacheSet('domains:active', domains, 300); // 5 minute cache
}

export async function getCachedDomains<T>(): Promise<T | null> {
  return cacheGet<T>('domains:active');
}

export async function invalidateDomainsCache(): Promise<void> {
  await cacheDelete('domains:active');
}

// ============================================================================
// Stats Cache
// ============================================================================

export async function cacheStats(stats: unknown): Promise<void> {
  await cacheSet('stats:global', stats, 60); // 1 minute cache
}

export async function getCachedStats<T>(): Promise<T | null> {
  return cacheGet<T>('stats:global');
}

export default {
  getRedisClient,
  connectRedis,
  disconnectRedis,
  isRedisConnected,
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheDeletePattern,
  checkRateLimit,
  isDeliveryRecorded,
  recordDelivery,
  storeToken,
  getToken,
  deleteToken,
  cacheAlias,
  getCachedAlias,
  invalidateAliasCache,
  cacheDomains,
  getCachedDomains,
  invalidateDomainsCache,
  cacheStats,
  getCachedStats,
};
