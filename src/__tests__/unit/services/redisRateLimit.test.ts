/**
 * Redis service: atomic rate limiting + delivery de-duplication
 */

import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';

type Entry = { value: string; ttl: number };
const store = new Map<string, Entry>();
const handlers: Record<string, (...args: any[]) => void> = {};
const execMock = jest.fn<(...args: any[]) => any>();
let lastMultiOps: string[] = [];

function makeMulti() {
  const ops: Array<() => [Error | null, unknown]> = [];
  const chain: any = {
    incr(k: string) {
      lastMultiOps.push('incr');
      ops.push(() => {
        const e = store.get(k) || { value: '0', ttl: -1 };
        e.value = String(parseInt(e.value) + 1);
        store.set(k, e);
        return [null, parseInt(e.value)];
      });
      return chain;
    },
    expire(k: string, seconds: number, mode?: string) {
      lastMultiOps.push(`expire:${mode}`);
      ops.push(() => {
        const e = store.get(k);
        if (!e) return [null, 0];
        if (mode === 'NX' && e.ttl !== -1) return [null, 0];
        e.ttl = seconds;
        return [null, 1];
      });
      return chain;
    },
    ttl(k: string) {
      lastMultiOps.push('ttl');
      ops.push(() => [null, store.get(k)?.ttl ?? -2]);
      return chain;
    },
    exec: () => execMock(ops),
  };
  return chain;
}

const client = {
  on: jest.fn((event: string, cb: (...args: any[]) => void) => {
    handlers[event] = cb;
  }),
  multi: jest.fn(() => {
    lastMultiOps = [];
    return makeMulti();
  }),
  exists: jest.fn(async (k: string) => (store.has(k) ? 1 : 0)),
  set: jest.fn(async (k: string, v: string, _ex: string, ttl: number, nx: string) => {
    if (nx === 'NX' && store.has(k)) return null;
    store.set(k, { value: v, ttl });
    return 'OK';
  }),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => client),
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as redisService from '../../../services/redis';
import logger from '../../../utils/logger';

describe('redis service', () => {
  beforeAll(() => {
    redisService.getRedisClient();
    handlers.connect();
  });

  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    execMock.mockImplementation(async (ops: any) => ops.map((op: () => unknown) => op()));
  });

  describe('checkRateLimit', () => {
    it('increments and sets TTL in a single MULTI transaction', async () => {
      const r = await redisService.checkRateLimit('forward:abc', 2, 60);
      expect(r.allowed).toBe(true);
      expect(lastMultiOps).toEqual(['incr', 'expire:NX', 'ttl']);
      expect(client.multi).toHaveBeenCalledTimes(1);
      // Exactly one key, and it has a TTL
      const entries = Array.from(store.values());
      expect(entries).toHaveLength(1);
      expect(entries[0].ttl).toBe(60);
    });

    it('blocks once the limit is exceeded', async () => {
      await redisService.checkRateLimit('id', 2, 60);
      await redisService.checkRateLimit('id', 2, 60);
      const r = await redisService.checkRateLimit('id', 2, 60);
      expect(r.allowed).toBe(false);
      expect(r.remaining).toBe(0);
    });

    it('repairs a legacy key that has no TTL', async () => {
      await redisService.checkRateLimit('legacy', 5, 60);
      const k = Array.from(store.keys())[0];
      store.get(k)!.ttl = -1;
      await redisService.checkRateLimit('legacy', 5, 60);
      expect(store.get(k)!.ttl).toBe(60);
    });

    it('fails open with a warning when the transaction throws', async () => {
      execMock.mockRejectedValueOnce(new Error('boom'));
      const r = await redisService.checkRateLimit('id', 1, 60);
      expect(r.allowed).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('fails open with a warning when a command in the transaction errors', async () => {
      execMock.mockResolvedValueOnce([[new Error('x'), null], [null, 1], [null, 60]]);
      const r = await redisService.checkRateLimit('id', 1, 60);
      expect(r.allowed).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('delivery records', () => {
    it('records a delivery once with a ~24h TTL and reports it', async () => {
      expect(await redisService.isDeliveryRecorded('msg-1\nrcpt@x')).toBe(false);
      expect(await redisService.recordDelivery('msg-1\nrcpt@x')).toBe(true);
      expect(await redisService.isDeliveryRecorded('msg-1\nrcpt@x')).toBe(true);
      expect(await redisService.recordDelivery('msg-1\nrcpt@x')).toBe(false);
      const [, , , ttl, nx] = client.set.mock.calls[0];
      expect(ttl).toBe(86400);
      expect(nx).toBe('NX');
    });

    it('does not store the raw id (keys are hashed)', async () => {
      await redisService.recordDelivery('<id@example.com>\nuser@example.com');
      for (const k of store.keys()) expect(k).not.toContain('example.com');
    });
  });

  it('exports invalidateAliasCache', () => {
    expect(typeof redisService.invalidateAliasCache).toBe('function');
  });
});
