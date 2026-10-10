/**
 * Auth middleware unit tests: JWT algorithm pinning, tokenVersion revocation,
 * and minimal token claims.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import type { Response, NextFunction } from 'express';

jest.mock('../../../services/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
  },
}));

import prisma from '../../../services/database';
import { authenticate, generateToken, verifyToken } from '../../../middleware/auth';
import { AuthenticatedRequest } from '../../../types';

const JWT_SECRET = process.env.JWT_SECRET as string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findUnique = prisma.user.findUnique as unknown as jest.Mock<(...args: any[]) => any>;

const dbUser = {
  id: 'user-1',
  email: 'owner@example.com',
  emailIv: null,
  emailSalt: null,
  emailAuthTag: null,
  isEmailEncrypted: false,
  isActive: true,
  isAdmin: false,
  tokenVersion: 3,
};

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

async function run(token: string | undefined) {
  const req = {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  } as unknown as AuthenticatedRequest;
  const res = mockRes();
  const next = jest.fn() as unknown as NextFunction;
  await authenticate(req, res as unknown as Response, next);
  return { req, res, next: next as unknown as jest.Mock };
}

describe('generateToken', () => {
  it('embeds only id and tv (no email or admin flag) and signs with HS256', () => {
    const token = generateToken({ id: 'user-1', tokenVersion: 3 });
    const decoded = jwt.decode(token, { complete: true }) as jwt.Jwt;

    expect(decoded.header.alg).toBe('HS256');
    const payload = decoded.payload as Record<string, unknown>;
    expect(payload.id).toBe('user-1');
    expect(payload.tv).toBe(3);
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('isAdmin');
  });
});

describe('verifyToken', () => {
  it('accepts a token from generateToken', () => {
    const token = generateToken({ id: 'user-1', tokenVersion: 0 });
    expect(verifyToken(token)).toMatchObject({ id: 'user-1', tv: 0 });
  });

  it('rejects tokens signed with another HMAC algorithm', () => {
    const token = jwt.sign({ id: 'user-1', tv: 0 }, JWT_SECRET, { algorithm: 'HS512' });
    expect(verifyToken(token)).toBeNull();
  });

  it('rejects tokens without a tv claim', () => {
    const token = jwt.sign({ id: 'user-1', email: 'x@example.com' }, JWT_SECRET);
    expect(verifyToken(token)).toBeNull();
  });
});

describe('authenticate middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue({ ...dbUser });
  });

  it('accepts a valid token whose tv matches the DB and populates req.user from the DB', async () => {
    const { req, res, next } = await run(generateToken({ id: 'user-1', tokenVersion: 3 }));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(req.user).toEqual({ id: 'user-1', email: 'owner@example.com', isAdmin: false });
  });

  it('takes isAdmin from the DB, not the token', async () => {
    findUnique.mockResolvedValue({ ...dbUser, isAdmin: true });
    const { req } = await run(generateToken({ id: 'user-1', tokenVersion: 3 }));
    expect(req.user?.isAdmin).toBe(true);
  });

  it('rejects a token whose tv is stale (e.g. after password change)', async () => {
    const { res, next } = await run(generateToken({ id: 'user-1', tokenVersion: 2 }));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects legacy tokens without a tv claim', async () => {
    const legacy = jwt.sign({ id: 'user-1', email: 'owner@example.com', isAdmin: true }, JWT_SECRET);
    const { res, next } = await run(legacy);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects alg=none tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: 'user-1', tv: 3 })).toString('base64url');
    const { res, next } = await run(`${header}.${payload}.`);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects tokens signed with HS512 even with the right secret', async () => {
    const token = jwt.sign({ id: 'user-1', tv: 3 }, JWT_SECRET, { algorithm: 'HS512' });
    const { res, next } = await run(token);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects inactive users', async () => {
    findUnique.mockResolvedValue({ ...dbUser, isActive: false });
    const { res, next } = await run(generateToken({ id: 'user-1', tokenVersion: 3 }));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing Authorization header', async () => {
    const { res, next } = await run(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
