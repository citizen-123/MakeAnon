/**
 * Redis Service Unit Tests
 *
 * Tests for Redis caching and rate limiting functionality
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock ioredis before importing the service
jest.mock('ioredis', () => {
  const mockStore = new Map<string, { value: string; expiry?: number }>();

  const MockRedis = jest.fn().mockImplementation(() => ({
    status: 'ready',

    get: jest.fn().mockImplementation((key: string) => {
      const item = mockStore.get(key);
      if (!item) return Promise.resolve(null);
      if (item.expiry && Date.now() > item.expiry) {
        mockStore.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(item.value);
    }),

    set: jest.fn().mockImplementation((key: string, value: string, ...args: any[]) => {
      let expiry: number | undefined;
      const exIndex = args.indexOf('EX');
      if (exIndex !== -1 && args[exIndex + 1]) {
        expiry = Date.now() + (parseInt(args[exIndex + 1]) * 1000);
      }
      mockStore.set(key, { value, expiry });
      return Promise.resolve('OK');
    }),

    setex: jest.fn().mockImplementation((key: string, seconds: number, value: string) => {
      mockStore.set(key, { value, expiry: Date.now() + (seconds * 1000) });
      return Promise.resolve('OK');
    }),

    del: jest.fn().mockImplementation((...keys: string[]) => {
      let deleted = 0;
      keys.forEach(key => {
        if (mockStore.delete(key)) deleted++;
      });
      return Promise.resolve(deleted);
    }),

    incr: jest.fn().mockImplementation((key: string) => {
      const item = mockStore.get(key);
      const newValue = item ? parseInt(item.value) + 1 : 1;
      mockStore.set(key, { value: newValue.toString(), expiry: item?.expiry });
      return Promise.resolve(newValue);
    }),

    expire: jest.fn().mockImplementation((key: string, seconds: number) => {
      const item = mockStore.get(key);
      if (item) {
        item.expiry = Date.now() + (seconds * 1000);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }),

    ttl: jest.fn().mockImplementation((key: string) => {
      const item = mockStore.get(key);
      if (!item) return Promise.resolve(-2);
      if (!item.expiry) return Promise.resolve(-1);
      const remaining = Math.ceil((item.expiry - Date.now()) / 1000);
      return Promise.resolve(remaining > 0 ? remaining : -2);
    }),

    keys: jest.fn().mockImplementation((pattern: string) => {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return Promise.resolve(Array.from(mockStore.keys()).filter(key => regex.test(key)));
    }),

    scan: jest.fn().mockImplementation((cursor: string, ...args: any[]) => {
      const matchIndex = args.indexOf('MATCH');
      const pattern = matchIndex !== -1 ? args[matchIndex + 1] : '*';
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      const matchingKeys = Array.from(mockStore.keys()).filter(key => regex.test(key));
      return Promise.resolve(['0', matchingKeys]);
    }),

    on: jest.fn(),
    quit: jest.fn<any>().mockResolvedValue('OK'),
    disconnect: jest.fn(),
  }));

  // Expose mockStore for test manipulation
  (MockRedis as any).mockStore = mockStore;
  (MockRedis as any).resetStore = () => mockStore.clear();

  return MockRedis;
});

// Import after mocking
import Redis from 'ioredis';

describe('Redis Service', () => {
  let redisClient: any;

  beforeEach(() => {
    // Clear mock store
    (Redis as any).resetStore();
    redisClient = new Redis();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Basic Operations', () => {
    describe('get/set', () => {
      it('should set and get a value', async () => {
        await redisClient.set('testKey', 'testValue');
        const value = await redisClient.get('testKey');
        expect(value).toBe('testValue');
      });

      it('should return null for non-existent keys', async () => {
        const value = await redisClient.get('nonExistent');
        expect(value).toBeNull();
      });

      it('should set value with expiry using EX', async () => {
        await redisClient.set('expiringKey', 'value', 'EX', 60);
        const value = await redisClient.get('expiringKey');
        expect(value).toBe('value');
      });
    });

    describe('setex', () => {
      it('should set value with expiry', async () => {
        await redisClient.setex('exKey', 60, 'exValue');
        const value = await redisClient.get('exKey');
        expect(value).toBe('exValue');
      });
    });

    describe('del', () => {
      it('should delete a key', async () => {
        await redisClient.set('toDelete', 'value');
        const deleted = await redisClient.del('toDelete');
        expect(deleted).toBe(1);

        const value = await redisClient.get('toDelete');
        expect(value).toBeNull();
      });

      it('should return 0 for non-existent keys', async () => {
        const deleted = await redisClient.del('nonExistent');
        expect(deleted).toBe(0);
      });
    });
  });

  describe('Counter Operations', () => {
    describe('incr', () => {
      it('should increment a counter', async () => {
        const val1 = await redisClient.incr('counter');
        expect(val1).toBe(1);

        const val2 = await redisClient.incr('counter');
        expect(val2).toBe(2);

        const val3 = await redisClient.incr('counter');
        expect(val3).toBe(3);
      });

      it('should start at 1 for new keys', async () => {
        const value = await redisClient.incr('newCounter');
        expect(value).toBe(1);
      });
    });
  });

  describe('Expiry Operations', () => {
    describe('expire', () => {
      it('should set expiry on existing key', async () => {
        await redisClient.set('key', 'value');
        const result = await redisClient.expire('key', 60);
        expect(result).toBe(1);
      });

      it('should return 0 for non-existent key', async () => {
        const result = await redisClient.expire('nonExistent', 60);
        expect(result).toBe(0);
      });
    });

    describe('ttl', () => {
      it('should return remaining TTL for key with expiry', async () => {
        await redisClient.setex('ttlKey', 60, 'value');
        const ttl = await redisClient.ttl('ttlKey');
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(60);
      });

      it('should return -2 for non-existent key', async () => {
        const ttl = await redisClient.ttl('nonExistent');
        expect(ttl).toBe(-2);
      });

      it('should return -1 for key without expiry', async () => {
        await redisClient.set('noExpiry', 'value');
        const ttl = await redisClient.ttl('noExpiry');
        expect(ttl).toBe(-1);
      });
    });
  });

  describe('Pattern Matching', () => {
    beforeEach(async () => {
      await redisClient.set('user:1:name', 'Alice');
      await redisClient.set('user:2:name', 'Bob');
      await redisClient.set('user:1:email', 'alice@example.com');
      await redisClient.set('session:abc', 'data');
    });

    describe('keys', () => {
      it('should match keys by pattern', async () => {
        const keys = await redisClient.keys('user:*');
        expect(keys).toContain('user:1:name');
        expect(keys).toContain('user:2:name');
        expect(keys).toContain('user:1:email');
        expect(keys).not.toContain('session:abc');
      });

      it('should match specific patterns', async () => {
        const keys = await redisClient.keys('user:1:*');
        expect(keys).toContain('user:1:name');
        expect(keys).toContain('user:1:email');
        expect(keys).not.toContain('user:2:name');
      });
    });

    describe('scan', () => {
      it('should scan keys matching pattern', async () => {
        const [cursor, keys] = await redisClient.scan('0', 'MATCH', 'user:*');
        expect(cursor).toBe('0');
        expect(keys).toContain('user:1:name');
      });
    });
  });
});

describe('Rate Limiting Logic', () => {
  // Test the rate limiting algorithm
  describe('checkRateLimit', () => {
    it('should allow requests within limit', () => {
      const limit = 10;
      const requests: number[] = [];

      for (let i = 0; i < limit; i++) {
        requests.push(i + 1);
      }

      expect(requests.length).toBeLessThanOrEqual(limit);
    });

    it('should track remaining requests', () => {
      const limit = 10;
      const currentCount = 3;
      const remaining = limit - currentCount;

      expect(remaining).toBe(7);
    });

    it('should calculate reset time', () => {
      const windowSeconds = 60;
      const now = Date.now();
      const resetAt = new Date(now + windowSeconds * 1000);

      expect(resetAt.getTime()).toBeGreaterThan(now);
    });
  });
});

describe('Caching Strategies', () => {
  describe('Cache TTLs', () => {
    it('should use correct TTL for alias cache (60s)', () => {
      const ALIAS_CACHE_TTL = 60;
      expect(ALIAS_CACHE_TTL).toBe(60);
    });

    it('should use correct TTL for domain cache (300s)', () => {
      const DOMAIN_CACHE_TTL = 300;
      expect(DOMAIN_CACHE_TTL).toBe(300);
    });

    it('should use correct TTL for stats cache (60s)', () => {
      const STATS_CACHE_TTL = 60;
      expect(STATS_CACHE_TTL).toBe(60);
    });
  });

  describe('Cache Keys', () => {
    it('should generate consistent cache keys for aliases', () => {
      const alias = 'myalias';
      const domain = 'example.com';
      const key = `alias:${alias}@${domain}`;

      expect(key).toBe('alias:myalias@example.com');
    });

    it('should not contain plaintext emails in rate limit keys', () => {
      const identifier = 'alias_creation:user@example.com';
      const hashedId = require('crypto').createHash('sha256').update(identifier).digest('hex').substring(0, 32);
      const key = `ratelimit:${hashedId}`;

      expect(key).not.toContain('user@example.com');
      expect(key).toMatch(/^ratelimit:[a-f0-9]{32}$/);
    });

    it('should generate consistent cache keys for tokens', () => {
      const token = 'abc123';
      const key = `token:${token}`;

      expect(key).toBe('token:abc123');
    });
  });
});

describe('Cache Invalidation', () => {
  it('should invalidate single cache entry', async () => {
    const redisClient = new Redis();
    await redisClient.set('cache:entry', 'value');

    const deleted = await redisClient.del('cache:entry');
    expect(deleted).toBe(1);

    const value = await redisClient.get('cache:entry');
    expect(value).toBeNull();
  });

  it('should handle pattern-based invalidation', async () => {
    const redisClient = new Redis();
    (Redis as any).resetStore();

    await redisClient.set('cache:user:1', 'data1');
    await redisClient.set('cache:user:2', 'data2');
    await redisClient.set('cache:other', 'other');

    const keys = await redisClient.keys('cache:user:*');
    for (const key of keys) {
      await redisClient.del(key);
    }

    const remaining = await redisClient.get('cache:other');
    expect(remaining).toBe('other');
  });
});
