/**
 * Redis/ioredis Mock
 *
 * Provides a mock implementation of Redis for testing
 */

import { jest } from '@jest/globals';

// In-memory storage for mock Redis
const mockStore = new Map<string, { value: string; expiry?: number }>();

export const resetMockRedis = () => {
  mockStore.clear();
};

export const mockRedisClient = {
  // Connection
  connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  quit: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
  ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG'),

  // Status
  status: 'ready',

  // Basic operations
  get: jest.fn<(key: string) => Promise<string | null>>().mockImplementation((key: string) => {
    const item = mockStore.get(key);
    if (!item) return Promise.resolve(null);
    if (item.expiry && Date.now() > item.expiry) {
      mockStore.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(item.value);
  }),

  set: jest.fn<(key: string, value: string, ...args: any[]) => Promise<string>>().mockImplementation((key: string, value: string, ...args: any[]) => {
    let expiry: number | undefined;
    // Handle EX option
    const exIndex = args.indexOf('EX');
    if (exIndex !== -1 && args[exIndex + 1]) {
      expiry = Date.now() + (parseInt(args[exIndex + 1]) * 1000);
    }
    mockStore.set(key, { value, expiry });
    return Promise.resolve('OK');
  }),

  setex: jest.fn<(key: string, seconds: number, value: string) => Promise<string>>().mockImplementation((key: string, seconds: number, value: string) => {
    mockStore.set(key, { value, expiry: Date.now() + (seconds * 1000) });
    return Promise.resolve('OK');
  }),

  del: jest.fn<(...keys: string[]) => Promise<number>>().mockImplementation((...keys: string[]) => {
    let deleted = 0;
    keys.forEach(key => {
      if (mockStore.delete(key)) deleted++;
    });
    return Promise.resolve(deleted);
  }),

  exists: jest.fn<(...keys: string[]) => Promise<number>>().mockImplementation((...keys: string[]) => {
    let count = 0;
    keys.forEach(key => {
      if (mockStore.has(key)) count++;
    });
    return Promise.resolve(count);
  }),

  // Increment operations
  incr: jest.fn<(key: string) => Promise<number>>().mockImplementation((key: string) => {
    const item = mockStore.get(key);
    const newValue = item ? parseInt(item.value) + 1 : 1;
    mockStore.set(key, { value: newValue.toString(), expiry: item?.expiry });
    return Promise.resolve(newValue);
  }),

  incrby: jest.fn<(key: string, increment: number) => Promise<number>>().mockImplementation((key: string, increment: number) => {
    const item = mockStore.get(key);
    const newValue = item ? parseInt(item.value) + increment : increment;
    mockStore.set(key, { value: newValue.toString(), expiry: item?.expiry });
    return Promise.resolve(newValue);
  }),

  // Expiry
  expire: jest.fn<(key: string, seconds: number) => Promise<number>>().mockImplementation((key: string, seconds: number) => {
    const item = mockStore.get(key);
    if (item) {
      item.expiry = Date.now() + (seconds * 1000);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }),

  ttl: jest.fn<(key: string) => Promise<number>>().mockImplementation((key: string) => {
    const item = mockStore.get(key);
    if (!item) return Promise.resolve(-2);
    if (!item.expiry) return Promise.resolve(-1);
    const remaining = Math.ceil((item.expiry - Date.now()) / 1000);
    return Promise.resolve(remaining > 0 ? remaining : -2);
  }),

  // Pattern matching
  keys: jest.fn<(pattern: string) => Promise<string[]>>().mockImplementation((pattern: string) => {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    const matchingKeys = Array.from(mockStore.keys()).filter(key => regex.test(key));
    return Promise.resolve(matchingKeys);
  }),

  scan: jest.fn<(cursor: string, ...args: any[]) => Promise<(string | string[])[]>>().mockImplementation((cursor: string, ...args: any[]) => {
    const matchIndex = args.indexOf('MATCH');
    const pattern = matchIndex !== -1 ? args[matchIndex + 1] : '*';
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    const matchingKeys = Array.from(mockStore.keys()).filter(key => regex.test(key));
    return Promise.resolve(['0', matchingKeys]);
  }),

  // Hash operations
  hget: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  hset: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  hdel: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  hgetall: jest.fn<() => Promise<Record<string, string>>>().mockResolvedValue({}),

  // List operations
  lpush: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  rpush: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  lpop: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  rpop: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  lrange: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
  llen: jest.fn<() => Promise<number>>().mockResolvedValue(0),

  // Set operations
  sadd: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  srem: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  smembers: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
  sismember: jest.fn<() => Promise<number>>().mockResolvedValue(0),

  // Events
  on: jest.fn(),
  once: jest.fn(),
  off: jest.fn(),

  // Pipeline for batch operations
  pipeline: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    incr: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn<() => Promise<any[]>>().mockResolvedValue([])
  })
};

// Export for jest.mock
export default mockRedisClient;

// Factory function
export const createMockRedisClient = () => {
  resetMockRedis();
  return { ...mockRedisClient };
};
