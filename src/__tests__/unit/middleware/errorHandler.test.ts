/**
 * Global error handler / 404 handler unit tests
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { globalErrorHandler, notFoundHandler } from '../../../middleware/errorHandler';

function mockRes() {
  return {
    statusCode: 200,
    headersSent: false,
    body: undefined as unknown as { success: boolean; error: string },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: { success: boolean; error: string }) {
      this.body = body;
      return this;
    },
  };
}

const req = { method: 'POST', path: '/api/v1/thing' } as unknown as Request;

function handle(err: Error) {
  const res = mockRes();
  const next = jest.fn() as unknown as NextFunction;
  globalErrorHandler(err, req, res as unknown as Response, next);
  return res;
}

function prismaError(code: string): Error {
  const err = new Error(`Invalid prisma call: secret details ${code}`);
  err.name = 'PrismaClientKnownRequestError';
  (err as Error & { code: string }).code = code;
  return err;
}

describe('globalErrorHandler', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('maps Prisma P2002 to 409', () => {
    const res = handle(prismaError('P2002'));
    expect(res.statusCode).toBe(409);
    expect(res.body.error).not.toContain('secret');
  });

  it('maps Prisma P2025 to 404', () => {
    expect(handle(prismaError('P2025')).statusCode).toBe(404);
  });

  it('maps other Prisma known errors to 500, not 400', () => {
    const res = handle(prismaError('P2003'));
    expect(res.statusCode).toBe(500);
    expect(res.body.error).not.toContain('secret');
  });

  it('maps malformed JSON bodies to 400', () => {
    const err = Object.assign(new SyntaxError('Unexpected token } in JSON at position 5'), {
      status: 400,
      type: 'entity.parse.failed',
    });
    const res = handle(err);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).not.toContain('Unexpected token');
  });

  it('maps oversized bodies to 413', () => {
    const err = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });
    expect(handle(err).statusCode).toBe(413);
  });

  it('hides 5xx error messages in production', () => {
    process.env.NODE_ENV = 'production';
    const res = handle(new Error('connection string postgres://user:pw@db'));
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('An unexpected error occurred');
  });
});

describe('notFoundHandler', () => {
  it('does not reflect the request path', () => {
    const res = mockRes();
    notFoundHandler(
      { method: 'GET', path: '/api/<script>alert(1)</script>' } as unknown as Request,
      res as unknown as Response
    );
    expect(res.statusCode).toBe(404);
    expect(res.body.error).not.toContain('script');
    expect(res.body.error).not.toContain('/api');
  });
});
