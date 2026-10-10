/**
 * App-level hardening: trust proxy, body size limit, docs gating, 404 body.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import type { Express } from 'express';
import request from 'supertest';

jest.mock('../../../services/database', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(async () => [1]),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  },
}));

jest.mock('../../../services/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
  isRedisConnected: jest.fn().mockReturnValue(false),
  checkRateLimit: jest.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })),
  invalidateAliasCache: jest.fn(),
  cacheAlias: jest.fn(),
  getCachedAlias: jest.fn(async () => null),
  getCachedDomains: jest.fn(async () => null),
  cacheDomains: jest.fn(),
  getCachedStats: jest.fn(async () => null),
  cacheStats: jest.fn(),
}));

async function loadApp(env: Record<string, string | undefined> = {}): Promise<Express> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let app!: Express;
  await jest.isolateModulesAsync(async () => {
    app = (await import('../../../app')).default;
  });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return app;
}

describe('app hardening', () => {
  let app: Express;

  beforeAll(async () => {
    app = await loadApp();
  });

  it('trusts X-Forwarded-For only from loopback / private hops', () => {
    const trust = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('::1', 0)).toBe(true);
    expect(trust('172.18.0.5', 0)).toBe(true); // docker bridge (Caddy)
    expect(trust('10.0.0.2', 0)).toBe(true);
    expect(trust('203.0.113.9', 0)).toBe(false); // public client
  });

  it('rejects JSON bodies over 100kb with 413', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(150 * 1024) });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(big);
    expect(res.status).toBe(413);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('does not reflect the path in API 404 responses', async () => {
    const res = await request(app).get('/api/v1/definitely-not-here-xyz');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('definitely-not-here-xyz');
  });

  it('serves API docs by default', async () => {
    const res = await request(app).get('/api/docs.json');
    expect(res.status).toBe(200);
  });

  describe('with ENABLE_API_DOCS=false', () => {
    let noDocsApp: Express;
    beforeAll(async () => {
      noDocsApp = await loadApp({ ENABLE_API_DOCS: 'false' });
    });
    afterAll(() => {
      delete process.env.ENABLE_API_DOCS;
    });

    it('does not serve docs.json or Swagger UI', async () => {
      expect((await request(noDocsApp).get('/api/docs.json')).status).toBe(404);
      expect((await request(noDocsApp).get('/api/docs/')).status).toBe(404);
    });
  });

  it('does not apply the global API rate limit to static assets', async () => {
    const res = await request(app).get('/');
    expect(res.headers['ratelimit-limit']).toBeUndefined();
    expect(res.headers['ratelimit']).toBeUndefined();
    const api = await request(app).get('/api/v1/definitely-not-here');
    expect(api.headers['ratelimit-policy'] ?? api.headers['ratelimit-limit']).toBeDefined();
  });
});
