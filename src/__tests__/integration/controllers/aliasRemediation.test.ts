/**
 * Alias / verification controller remediation tests
 *
 * Covers: verification-before-forwarding, per-IP limits, input validation,
 * sender-block pattern rules, cache invalidation and verification decrypting.
 */

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
import express, { Express } from 'express';
import request from 'supertest';

jest.mock('../../../services/database', () => ({
  __esModule: true,
  default: {
    alias: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    domain: { update: jest.fn(), findUnique: jest.fn() },
    blockedSender: { upsert: jest.fn(), deleteMany: jest.fn() },
    emailLog: { findMany: jest.fn(), count: jest.fn() },
  },
}));

jest.mock('../../../services/redis', () => ({
  checkRateLimit: jest.fn(),
  invalidateAliasCache: jest.fn(),
}));

jest.mock('../../../services/domainService', () => ({
  getDefaultDomain: jest.fn(),
  getDomainById: jest.fn(),
}));

jest.mock('../../../services/verificationService', () => ({
  sendAliasVerificationEmail: jest.fn(),
  sendManagementLinkEmail: jest.fn(),
  verifyToken: jest.fn(),
}));

import prisma from '../../../services/database';
import * as redis from '../../../services/redis';
import * as domainService from '../../../services/domainService';
import * as verificationService from '../../../services/verificationService';
import { encryptEmail, hashEmail } from '../../../utils/encryption';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = (fn: unknown) => fn as jest.Mock<(...args: any[]) => any>;

const DOMAIN = { id: 'domain-1', domain: 'test.example.com', description: null, isDefault: true, aliasCount: 0 };

function buildApp(controllers: any, verify: any): Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (req.headers['x-test-user']) {
      req.user = { id: String(req.headers['x-test-user']), email: 'owner@example.com', isAdmin: false };
    }
    next();
  });
  app.post('/alias', controllers.createPublicAlias);
  app.put('/manage/:token', controllers.updateAliasByToken);
  app.post('/manage/:token/block', controllers.blockSender);
  app.delete('/manage/:token/block/:senderId', controllers.unblockSender);
  app.post('/aliases', controllers.createPrivateAlias);
  app.get('/aliases', controllers.getAliases);
  app.get('/logs', controllers.getEmailLogs);
  app.put('/aliases/:id', controllers.updateAlias);
  app.post('/aliases/:id/toggle', controllers.toggleAlias);
  app.get('/verify/:token', verify.verifyAliasEmail);
  app.post('/verify/resend', verify.resendVerification);
  return app;
}

describe('Alias remediation', () => {
  let app: Express;

  beforeAll(async () => {
    delete process.env.REQUIRE_EMAIL_VERIFICATION; // default must be "required"
    const controllers = await import('../../../controllers/aliasController');
    const verify = await import('../../../controllers/verifyController');
    app = buildApp(controllers, verify);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    m(redis.checkRateLimit).mockResolvedValue({ allowed: true, remaining: 5, resetAt: new Date() });
    m(domainService.getDefaultDomain).mockResolvedValue(DOMAIN);
    m(domainService.getDomainById).mockResolvedValue(DOMAIN);
    m(prisma.alias.count).mockResolvedValue(0);
    m(prisma.alias.findFirst).mockResolvedValue(null);
    m(prisma.alias.create).mockImplementation(async (args: any) => ({
      ...args.data,
      createdAt: new Date(),
      domain: { id: DOMAIN.id, domain: DOMAIN.domain },
    }));
    m(prisma.domain.update).mockResolvedValue({});
    m(verificationService.sendAliasVerificationEmail).mockResolvedValue(true);
  });

  describe('POST /alias (public)', () => {
    it('creates aliases inactive and unverified, and sends verification by alias id', async () => {
      const res = await request(app).post('/alias').send({ destinationEmail: 'User@Example.com' });

      expect(res.status).toBe(201);
      const data = m(prisma.alias.create).mock.calls[0][0].data;
      expect(data.isActive).toBe(false);
      expect(data.emailVerified).toBe(false);
      expect(m(verificationService.sendAliasVerificationEmail)).toHaveBeenCalledWith(
        'user@example.com',
        data.fullAddress,
        data.id
      );
    });

    it('applies a per-IP rate limit', async () => {
      m(redis.checkRateLimit).mockImplementation(async (key: string) => ({
        allowed: !key.startsWith('alias:create:ip:'),
        remaining: 0,
        resetAt: new Date(Date.now() + 1000),
      }));

      const res = await request(app)
        .post('/alias')
        .set('X-Forwarded-For', '203.0.113.9')
        .send({ destinationEmail: 'user@example.com' });

      expect(res.status).toBe(429);
      expect(m(redis.checkRateLimit).mock.calls[0][0]).toBe('alias:create:ip:203.0.113.9');
      expect(m(prisma.alias.create)).not.toHaveBeenCalled();
    });

    it('keys the per-destination limit by hash, not plaintext', async () => {
      await request(app).post('/alias').send({ destinationEmail: 'user@example.com' });
      const keys = m(redis.checkRateLimit).mock.calls.map((c: any[]) => c[0]);
      expect(keys.some((k: string) => k.includes('user@example.com'))).toBe(false);
      expect(keys).toContain(`alias:create:${hashEmail('user@example.com')}`);
    });

    it('counts only active/pending aliases and does not reveal the count', async () => {
      m(prisma.alias.count).mockResolvedValue(10);
      const res = await request(app).post('/alias').send({ destinationEmail: 'user@example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).not.toMatch(/\d/);
      const where = m(prisma.alias.count).mock.calls[0][0].where;
      expect(where.OR).toEqual([{ isActive: true }, { emailVerified: false }]);
    });

    it('rejects non-string / out of range expiresIn', async () => {
      for (const expiresIn of ['7', 0, 366, 1e12, 2.5]) {
        const res = await request(app).post('/alias').send({ destinationEmail: 'user@example.com', expiresIn });
        expect(res.status).toBe(400);
      }
      expect(m(prisma.alias.create)).not.toHaveBeenCalled();
    });

    it('rejects overlong or non-string labels/descriptions', async () => {
      const r1 = await request(app).post('/alias').send({ destinationEmail: 'user@example.com', label: 'x'.repeat(101) });
      const r2 = await request(app).post('/alias').send({ destinationEmail: 'user@example.com', description: { a: 1 } });
      expect(r1.status).toBe(400);
      expect(r2.status).toBe(400);
    });

    it('rejects reserved custom aliases', async () => {
      const res = await request(app).post('/alias').send({ destinationEmail: 'user@example.com', customAlias: 'Postmaster' });
      expect(res.status).toBe(400);
    });

    it('rejects non-string domainId and only accepts active public domains', async () => {
      const r1 = await request(app).post('/alias').send({ destinationEmail: 'user@example.com', domainId: { not: '' } });
      expect(r1.status).toBe(400);

      m(domainService.getDomainById).mockResolvedValue(null);
      const r2 = await request(app).post('/alias').send({ destinationEmail: 'user@example.com', domainId: 'inactive' });
      expect(r2.status).toBe(400);
      expect(m(domainService.getDomainById)).toHaveBeenCalledWith('inactive', { activeOnly: true, publicOnly: true });
    });
  });

  describe('PUT /manage/:token', () => {
    const base = { id: 'a1', fullAddress: 'abc@test.example.com', isActive: false, emailVerified: false };

    it('refuses to activate an unverified alias', async () => {
      m(prisma.alias.findUnique).mockResolvedValue(base);
      const res = await request(app).put('/manage/tok').send({ isActive: true });
      expect(res.status).toBe(403);
      expect(m(prisma.alias.update)).not.toHaveBeenCalled();
    });

    it('sets disabledAt when disabling and invalidates cache', async () => {
      m(prisma.alias.findUnique).mockResolvedValue({ ...base, isActive: true, emailVerified: true });
      m(prisma.alias.update).mockResolvedValue({ ...base, domain: DOMAIN });
      const res = await request(app).put('/manage/tok').send({ isActive: false });
      expect(res.status).toBe(200);
      expect(m(prisma.alias.update).mock.calls[0][0].data.disabledAt).toBeInstanceOf(Date);
      expect(m(redis.invalidateAliasCache)).toHaveBeenCalledWith('abc@test.example.com');
    });

    it('rejects non-boolean isActive', async () => {
      const res = await request(app).put('/manage/tok').send({ isActive: 'yes' });
      expect(res.status).toBe(400);
    });
  });

  describe('sender blocking', () => {
    beforeEach(() => {
      m(prisma.alias.findUnique).mockResolvedValue({ id: 'a1', fullAddress: 'abc@test.example.com' });
      m(prisma.blockedSender.upsert).mockResolvedValue({});
      m(prisma.blockedSender.deleteMany).mockResolvedValue({ count: 1 });
    });

    it('collapses consecutive wildcards and invalidates the alias cache', async () => {
      const res = await request(app).post('/manage/tok/block').send({ email: '***@SPAM.com', isPattern: true });
      expect(res.status).toBe(200);
      expect(m(prisma.blockedSender.upsert).mock.calls[0][0].create.email).toBe('*@spam.com');
      expect(m(redis.invalidateAliasCache)).toHaveBeenCalledWith('abc@test.example.com');
    });

    it('rejects patterns with too many wildcards, too long, or non-string', async () => {
      const cases = [
        { email: '*a*b*c*d*e*f@spam.com', isPattern: true },
        { email: '*@' + 'a'.repeat(260) + '.com', isPattern: true },
        { email: ['*@spam.com'], isPattern: true },
        { email: 'x@spam.com', reason: 'r'.repeat(201) },
      ];
      for (const body of cases) {
        const res = await request(app).post('/manage/tok/block').send(body);
        expect(res.status).toBe(400);
      }
      expect(m(prisma.blockedSender.upsert)).not.toHaveBeenCalled();
    });

    it('invalidates the alias cache on unblock', async () => {
      await request(app).delete('/manage/tok/block/s1');
      expect(m(redis.invalidateAliasCache)).toHaveBeenCalledWith('abc@test.example.com');
    });
  });

  describe('private aliases', () => {
    const user = (overrides: Record<string, unknown> = {}) => ({
      email: 'owner@example.com',
      emailHash: hashEmail('owner@example.com'),
      isEmailEncrypted: false,
      emailVerified: true,
      maxAliases: 100,
      ...overrides,
    });

    it("auto-verifies only the owner's own verified address", async () => {
      m(prisma.user.findUnique).mockResolvedValue(user());
      await request(app).post('/aliases').set('x-test-user', 'u1').send({});
      const data = m(prisma.alias.create).mock.calls[0][0].data;
      expect(data.emailVerified).toBe(true);
      expect(data.isActive).toBe(true);
      expect(m(verificationService.sendAliasVerificationEmail)).not.toHaveBeenCalled();
    });

    it('requires verification for a different destination', async () => {
      m(prisma.user.findUnique).mockResolvedValue(user());
      const res = await request(app).post('/aliases').set('x-test-user', 'u1').send({ destinationEmail: 'victim@example.com' });
      expect(res.status).toBe(201);
      const data = m(prisma.alias.create).mock.calls[0][0].data;
      expect(data.emailVerified).toBe(false);
      expect(data.isActive).toBe(false);
      expect(m(verificationService.sendAliasVerificationEmail)).toHaveBeenCalledWith('victim@example.com', data.fullAddress, data.id);
    });

    it('requires verification when the owner email is unverified', async () => {
      m(prisma.user.findUnique).mockResolvedValue(user({ emailVerified: false }));
      await request(app).post('/aliases').set('x-test-user', 'u1').send({});
      expect(m(prisma.alias.create).mock.calls[0][0].data.isActive).toBe(false);
    });

    it('validates the destination email', async () => {
      const res = await request(app).post('/aliases').set('x-test-user', 'u1').send({ destinationEmail: 'a@b.com,c@d.com' });
      expect(res.status).toBe(400);
    });

    it('whitelists sortBy/sortOrder and clamps pagination', async () => {
      m(prisma.alias.findMany).mockResolvedValue([]);
      m(prisma.alias.count).mockResolvedValue(0);
      await request(app).get('/aliases?sortBy=destinationEmail&sortOrder=sideways&limit=9999&page=-3').set('x-test-user', 'u1');
      const args = m(prisma.alias.findMany).mock.calls[0][0];
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.take).toBe(100);
      expect(args.skip).toBe(0);
    });

    it('rejects non-string log filters', async () => {
      const res = await request(app).get('/logs?aliasId=a&aliasId=b').set('x-test-user', 'u1');
      expect(res.status).toBe(400);
    });

    it('toggle refuses to activate unverified aliases and clears disabledAt when activating verified', async () => {
      m(prisma.alias.findFirst).mockResolvedValue({ id: 'a1', fullAddress: 'x@test.example.com', isActive: false, emailVerified: false });
      const r1 = await request(app).post('/aliases/a1/toggle').set('x-test-user', 'u1');
      expect(r1.status).toBe(403);

      m(prisma.alias.findFirst).mockResolvedValue({ id: 'a1', fullAddress: 'x@test.example.com', isActive: false, emailVerified: true });
      m(prisma.alias.update).mockResolvedValue({ id: 'a1', isActive: true, domain: DOMAIN });
      const r2 = await request(app).post('/aliases/a1/toggle').set('x-test-user', 'u1');
      expect(r2.status).toBe(200);
      expect(m(prisma.alias.update).mock.calls[0][0].data).toEqual({ isActive: true, disabledAt: null });
      expect(m(redis.invalidateAliasCache)).toHaveBeenCalledWith('x@test.example.com');
    });
  });

  describe('verification', () => {
    const encrypted = encryptEmail('user@example.com', 'a1');
    const alias = {
      id: 'a1',
      fullAddress: 'abc@test.example.com',
      destinationEmail: encrypted.ciphertext,
      destinationIv: encrypted.iv,
      destinationSalt: encrypted.salt,
      destinationAuthTag: encrypted.authTag,
      destinationHash: hashEmail('user@example.com'),
      isEncrypted: true,
      managementToken: 'mgmt',
      emailVerified: false,
    };

    it('activates the alias, invalidates cache and mails the DECRYPTED address', async () => {
      m(verificationService.verifyToken).mockResolvedValue({
        success: true,
        email: hashEmail('user@example.com'),
        metadata: { aliasId: 'a1' },
      });
      m(prisma.alias.findUnique).mockResolvedValue(alias);
      m(prisma.alias.update).mockResolvedValue({});

      const res = await request(app).get('/verify/vtok');

      expect(res.status).toBe(302);
      expect(m(prisma.alias.update).mock.calls[0][0].data).toMatchObject({ emailVerified: true, isActive: true });
      expect(m(redis.invalidateAliasCache)).toHaveBeenCalledWith('abc@test.example.com');
      expect(m(verificationService.sendManagementLinkEmail).mock.calls[0][0]).toBe('user@example.com');
    });

    it('rejects legacy tokens without aliasId', async () => {
      m(verificationService.verifyToken).mockResolvedValue({ success: true, email: 'x', metadata: { managementToken: 'mgmt' } });
      const res = await request(app).get('/verify/vtok');
      expect(res.status).toBe(400);
      expect(m(prisma.alias.update)).not.toHaveBeenCalled();
    });

    it('resend: rejects operator-injection objects', async () => {
      const res = await request(app).post('/verify/resend').send({ aliasId: { not: '' } });
      expect(res.status).toBe(400);
      expect(m(prisma.alias.findFirst)).not.toHaveBeenCalled();
    });

    it('resend: uniform 200 whether or not the alias exists or sending fails', async () => {
      m(prisma.alias.findFirst).mockResolvedValue(null);
      const r1 = await request(app).post('/verify/resend').send({ aliasId: 'missing' });

      m(prisma.alias.findFirst).mockResolvedValue(alias);
      m(verificationService.sendAliasVerificationEmail).mockResolvedValue(false);
      const r2 = await request(app).post('/verify/resend').send({ aliasId: 'a1' });

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r1.body).toEqual(r2.body);
      expect(m(verificationService.sendAliasVerificationEmail)).toHaveBeenCalledWith('user@example.com', alias.fullAddress, 'a1');
    });
  });
});
