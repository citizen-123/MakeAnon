/**
 * Auth routes integration tests (real controller + routes + limiters,
 * mocked Prisma and Redis).
 */

import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import express, { Express } from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

jest.mock('../../../services/database', () => {
  const db = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    alias: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    domain: {
      update: jest.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: jest.fn(async (fn: any) => fn(db)),
  };
  return { __esModule: true, default: db };
});

jest.mock('../../../services/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
  invalidateAliasCache: jest.fn(async () => undefined),
}));

import prisma from '../../../services/database';
import * as redisService from '../../../services/redis';
import { encryptEmail, hashEmail } from '../../../utils/encryption';

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = prisma as any;
const JWT_SECRET = process.env.JWT_SECRET as string;
const PASSWORD = 'CorrectHorse1';
let PASSWORD_HASH: string;

let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`;
let emailCounter = 0;
const freshEmail = () => `user${++emailCounter}@example.com`;

function makeUser(email: string, overrides: Record<string, unknown> = {}) {
  const id = `user-${email}`;
  const enc = encryptEmail(email, id);
  return {
    id,
    email: enc.ciphertext,
    emailHash: hashEmail(email),
    emailIv: enc.iv,
    emailSalt: enc.salt,
    emailAuthTag: enc.authTag,
    isEmailEncrypted: true,
    password: PASSWORD_HASH,
    name: null,
    isActive: true,
    isAdmin: false,
    maxAliases: 50,
    tokenVersion: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

let app: Express;

// bcrypt cost 12 in the controller is intentionally slow
jest.setTimeout(30000);

beforeAll(async () => {
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);
  const { default: authRoutes } = await import('../../../routes/authRoutes');
  const { globalErrorHandler } = await import('../../../middleware/errorHandler');
  app = express();
  app.set('trust proxy', true); // lets each test use its own client IP
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  app.use(globalErrorHandler);
});

beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
});

describe('POST /auth/login', () => {
  const login = (ip: string, email: string, password: string) =>
    request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password });

  it('returns a token carrying id + tv only on success', async () => {
    const email = freshEmail();
    db.user.findUnique.mockResolvedValue(makeUser(email, { tokenVersion: 4 }));

    const res = await login(freshIp(), email, PASSWORD);

    expect(res.status).toBe(200);
    const payload = jwt.verify(res.body.data.token, JWT_SECRET) as Record<string, unknown>;
    expect(payload.tv).toBe(4);
    expect(payload).not.toHaveProperty('email');
  });

  it.each([
    ['nonexistent user', () => null],
    ['deactivated user', (e: string) => makeUser(e, { isActive: false })],
    ['passwordless user', (e: string) => makeUser(e, { password: null })],
    ['wrong password', (e: string) => makeUser(e)],
  ])('returns identical 401 for %s', async (_label, userFactory) => {
    const email = freshEmail();
    db.user.findUnique.mockResolvedValue(userFactory(email));
    const password = _label === 'wrong password' ? 'WrongPassword1' : PASSWORD;

    const res = await login(freshIp(), email, password);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Invalid email or password' });
  });

  it('still runs a bcrypt compare when the user does not exist (timing equalisation)', async () => {
    db.user.findUnique.mockResolvedValue(null);
    const spy = jest.spyOn(bcrypt, 'compare');

    await login(freshIp(), freshEmail(), PASSWORD);

    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0] as unknown[])[1]).toMatch(/^\$2[aby]\$12\$/);
    spy.mockRestore();
  });

  it('limits failed attempts per account to 5 per window, across IPs', async () => {
    const email = freshEmail();
    db.user.findUnique.mockResolvedValue(makeUser(email));

    for (let i = 0; i < 5; i++) {
      const r = await login(freshIp(), email, 'WrongPassword1');
      expect(r.status).toBe(401);
    }
    const blocked = await login(freshIp(), email, PASSWORD);
    expect(blocked.status).toBe(429);
  });

  it('limits attempts per IP to 10 per window', async () => {
    const ip = freshIp();
    db.user.findUnique.mockResolvedValue(null);
    // Skip the deliberately slow dummy cost-12 compare to keep the test fast
    const spy = jest.spyOn(bcrypt, 'compare').mockImplementation(async () => false);

    for (let i = 0; i < 10; i++) {
      const r = await login(ip, freshEmail(), 'WrongPassword1');
      expect(r.status).toBe(401);
    }
    const blocked = await login(ip, freshEmail(), 'WrongPassword1');
    expect(blocked.status).toBe(429);
    spy.mockRestore();
  });
});

describe('POST /auth/signup', () => {
  const signup = (ip: string, body: Record<string, unknown>) =>
    request(app).post('/api/v1/auth/signup').set('X-Forwarded-For', ip).send(body);

  beforeEach(() => {
    db.user.create.mockImplementation(async ({ data }: any) => ({
      ...data,
      maxAliases: 50,
      tokenVersion: 0,
      createdAt: new Date(),
    }));
  });

  it('never grants admin, even to the first user or ADMIN_EMAIL', async () => {
    const email = freshEmail();
    process.env.ADMIN_EMAIL = email;
    db.user.findUnique.mockResolvedValue(null);
    db.user.count.mockResolvedValue(0);

    const res = await signup(freshIp(), { email, password: PASSWORD });
    delete process.env.ADMIN_EMAIL;

    expect(res.status).toBe(201);
    expect(res.body.data.user.isAdmin).toBe(false);
    expect(db.user.create.mock.calls[0][0].data.isAdmin).toBe(false);
  });

  it('refuses to set a password on an existing passwordless account (no takeover)', async () => {
    const email = freshEmail();
    db.user.findUnique.mockResolvedValue(makeUser(email, { password: null }));

    const res = await signup(freshIp(), { email, password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.data).toBeUndefined();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('limits signups to 5 per hour per IP', async () => {
    const ip = freshIp();
    db.user.findUnique.mockResolvedValue(null);

    for (let i = 0; i < 5; i++) {
      const r = await signup(ip, { email: freshEmail(), password: PASSWORD });
      expect(r.status).toBe(201);
    }
    const blocked = await signup(ip, { email: freshEmail(), password: PASSWORD });
    expect(blocked.status).toBe(429);
  });
});

describe('POST /auth/change-password', () => {
  it('bumps tokenVersion, returns a fresh token, and the old token stops working', async () => {
    const email = freshEmail();
    const user = makeUser(email, { tokenVersion: 0 });
    db.user.findUnique.mockResolvedValue(user);
    db.user.update.mockResolvedValue({ id: user.id, tokenVersion: 1 });

    const oldToken = jwt.sign({ id: user.id, tv: 0 }, JWT_SECRET, { algorithm: 'HS256' });

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({ currentPassword: PASSWORD, newPassword: 'NewPassword2' });

    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
    const fresh = jwt.verify(res.body.data.token, JWT_SECRET) as Record<string, unknown>;
    expect(fresh.tv).toBe(1);

    // DB now at tokenVersion 1: the old token is rejected
    db.user.findUnique.mockResolvedValue({ ...user, tokenVersion: 1 });
    const again = await request(app)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${oldToken}`);
    expect(again.status).toBe(401);
  });
});

describe('DELETE /auth/account', () => {
  it('deletes aliases in a transaction, fixes domain counts, and invalidates alias cache', async () => {
    const email = freshEmail();
    const user = makeUser(email);
    db.user.findUnique.mockResolvedValue(user);
    db.alias.findMany.mockResolvedValue([
      { id: 'a1', fullAddress: 'one@d1.test', domainId: 'd1' },
      { id: 'a2', fullAddress: 'two@d1.test', domainId: 'd1' },
      { id: 'a3', fullAddress: 'three@d2.test', domainId: 'd2' },
    ]);
    db.alias.deleteMany.mockResolvedValue({ count: 3 });
    db.user.delete.mockResolvedValue({ id: user.id });

    const token = jwt.sign({ id: user.id, tv: 0 }, JWT_SECRET, { algorithm: 'HS256' });
    const res = await request(app)
      .delete('/api/v1/auth/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD });

    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.alias.deleteMany).toHaveBeenCalledWith({ where: { userId: user.id } });
    expect(db.domain.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { aliasCount: { decrement: 2 } },
    });
    expect(db.domain.update).toHaveBeenCalledWith({
      where: { id: 'd2' },
      data: { aliasCount: { decrement: 1 } },
    });
    expect(db.user.delete).toHaveBeenCalledWith({ where: { id: user.id } });

    const invalidate = redisService.invalidateAliasCache as unknown as jest.Mock;
    expect(invalidate.mock.calls.map((c) => c[0]).sort()).toEqual(
      ['one@d1.test', 'three@d2.test', 'two@d1.test']
    );
  });
});
