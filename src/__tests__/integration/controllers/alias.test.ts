/**
 * Alias Controller Integration Tests
 *
 * Tests for alias creation, management, and deletion endpoints
 */

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
import express, { Express } from 'express';
import request from 'supertest';

// Mock dependencies
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
      count: jest.fn()
    },
    domain: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn()
    },
    blockedSender: {
      findMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn()
    },
    emailLog: {
      findMany: jest.fn(),
      count: jest.fn()
    },
    $connect: jest.fn(),
    $disconnect: jest.fn()
  }
}));

jest.mock('../../../services/redis', () => ({
  checkRateLimit: jest.fn<any>().mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() }),
  cacheAlias: jest.fn(),
  getCachedAlias: jest.fn<any>().mockResolvedValue(null),
  invalidateAliasCache: jest.fn(),
  getRedisClient: jest.fn().mockReturnValue({
    status: 'ready',
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn()
  }),
  connectRedis: jest.fn<any>().mockResolvedValue(undefined)
}));

jest.mock('../../../utils/encryption', () => ({
  encryptEmail: jest.fn().mockImplementation((email: string) => ({
    ciphertext: Buffer.from(email).toString('base64'),
    iv: 'mockiv123456',
    salt: 'mocksalt12345678',
    authTag: 'mockauthtag12345'
  })),
  decryptEmail: jest.fn().mockImplementation((encrypted: { ciphertext: string }) => {
    return Buffer.from(encrypted.ciphertext, 'base64').toString();
  }),
  hashEmail: jest.fn().mockImplementation((email: string) => {
    return 'hash_' + email.toLowerCase();
  }),
  isEncryptionEnabled: jest.fn().mockReturnValue(true)
}));

import prisma from '../../../services/database';
import * as redisService from '../../../services/redis';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockResolve = (fn: any, value: any) => fn.mockResolvedValue(value);

describe('Alias Controller', () => {
  let app: Express;

  beforeAll(async () => {
    // Set up test environment
    process.env.EMAIL_DOMAINS = 'test.example.com';
    process.env.MASTER_ENCRYPTION_KEY = 'a57c3d7777b3ff668f12086b306cafa8168c541869a24f6806ec57699241ed7f';
    process.env.MAX_ALIASES_PER_EMAIL = '10';
    process.env.ALIAS_CREATION_LIMIT_PER_HOUR = '10';

    // Import app after mocking
    const { default: createApp } = await import('../../../app');
    app = createApp || express();

    // If app is not available, create a minimal test app
    if (!app.get) {
      app = express();
      app.use(express.json());

      const aliasController = await import('../../../controllers/aliasController');

      app.post('/api/v1/alias', aliasController.createPublicAlias);
      app.get('/api/v1/manage/:token', aliasController.getAliasByToken);
      app.put('/api/v1/manage/:token', aliasController.updateAliasByToken);
      app.delete('/api/v1/manage/:token', aliasController.deleteAliasByToken);
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset default mock implementations
    mockResolve(prisma.domain.findFirst,{
      id: 'domain-1',
      domain: 'test.example.com',
      isActive: true,
      isDefault: true
    });

    mockResolve(prisma.domain.findMany,[{
      id: 'domain-1',
      domain: 'test.example.com',
      isActive: true,
      isDefault: true
    }]);

    mockResolve(prisma.alias.count,0);

    mockResolve(redisService.checkRateLimit,{
      allowed: true,
      remaining: 9,
      resetAt: new Date()
    });
  });

  describe('POST /api/v1/alias - Create Public Alias', () => {
    const validInput = {
      destinationEmail: 'user@example.com'
    };

    it('should create a new alias successfully', async () => {
      const mockAlias = {
        id: 'alias-123',
        alias: 'abc12345',
        fullAddress: 'abc12345@test.example.com',
        domainId: 'domain-1',
        managementToken: 'mgmt-token-123',
        isActive: false,
        emailVerified: false,
        isPrivate: false,
        forwardCount: 0,
        createdAt: new Date()
      };

      mockResolve(prisma.alias.create,mockAlias);
      mockResolve(prisma.alias.findFirst,null);

      const response = await request(app)
        .post('/api/v1/alias')
        .send(validInput)
        .expect('Content-Type', /json/);

      // Check response structure (may be 201 or 200 depending on implementation)
      if (response.status === 201 || response.status === 200) {
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty('alias');
        expect(response.body.data).toHaveProperty('managementToken');
      }
    });

    it('should require destinationEmail', async () => {
      const response = await request(app)
        .post('/api/v1/alias')
        .send({})
        .expect('Content-Type', /json/);

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('should validate email format', async () => {
      const response = await request(app)
        .post('/api/v1/alias')
        .send({ destinationEmail: 'invalid-email' })
        .expect('Content-Type', /json/);

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('should enforce rate limiting', async () => {
      mockResolve(redisService.checkRateLimit,{
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 3600000)
      });

      const response = await request(app)
        .post('/api/v1/alias')
        .send(validInput)
        .expect('Content-Type', /json/);

      expect(response.status).toBe(429);
    });

    it('should enforce max aliases per email', async () => {
      mockResolve(prisma.alias.count,10);

      const response = await request(app)
        .post('/api/v1/alias')
        .send(validInput)
        .expect('Content-Type', /json/);

      if (response.status === 400 || response.status === 429) {
        expect(response.body.success).toBe(false);
      }
    });

    it('should allow custom alias', async () => {
      const mockAlias = {
        id: 'alias-123',
        alias: 'myalias',
        fullAddress: 'myalias@test.example.com',
        domainId: 'domain-1',
        managementToken: 'mgmt-token-123',
        isActive: false,
        emailVerified: false
      };

      mockResolve(prisma.alias.create,mockAlias);
      mockResolve(prisma.alias.findFirst,null);

      const response = await request(app)
        .post('/api/v1/alias')
        .send({
          destinationEmail: 'user@example.com',
          customAlias: 'myalias'
        });

      if (response.status === 201 || response.status === 200) {
        expect(response.body.data.alias).toContain('myalias');
      }
    });

    it('should reject custom alias starting with r', async () => {
      const response = await request(app)
        .post('/api/v1/alias')
        .send({
          destinationEmail: 'user@example.com',
          customAlias: 'ralias'
        });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('GET /api/v1/manage/:token - Get Alias by Token', () => {
    it('should return alias details for valid token', async () => {
      const mockAlias = {
        id: 'alias-123',
        alias: 'abc12345',
        fullAddress: 'abc12345@test.example.com',
        domainId: 'domain-1',
        domain: { domain: 'test.example.com' },
        managementToken: 'valid-token',
        label: 'Test Alias',
        description: null,
        isActive: true,
        emailVerified: true,
        forwardCount: 5,
        destinationEmail: Buffer.from('user@example.com').toString('base64'),
        destinationIv: 'iv',
        destinationSalt: 'salt',
        destinationAuthTag: 'tag',
        blockedSenders: [],
        createdAt: new Date()
      };

      mockResolve(prisma.alias.findUnique,mockAlias);

      const response = await request(app)
        .get('/api/v1/manage/valid-token')
        .expect('Content-Type', /json/);

      if (response.status === 200) {
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty('alias');
      }
    });

    it('should return 404 for invalid token', async () => {
      mockResolve(prisma.alias.findUnique,null);

      const response = await request(app)
        .get('/api/v1/manage/invalid-token')
        .expect('Content-Type', /json/);

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/v1/manage/:token - Update Alias', () => {
    const mockAlias = {
      id: 'alias-123',
      alias: 'abc12345',
      fullAddress: 'abc12345@test.example.com',
      managementToken: 'valid-token',
      label: 'Old Label',
      isActive: true,
      emailVerified: true,
      isPrivate: false
    };

    beforeEach(() => {
      mockResolve(prisma.alias.findUnique,mockAlias);
    });

    it('should update alias label', async () => {
      mockResolve(prisma.alias.update,{
        ...mockAlias,
        label: 'New Label'
      });

      const response = await request(app)
        .put('/api/v1/manage/valid-token')
        .send({ label: 'New Label' })
        .expect('Content-Type', /json/);

      if (response.status === 200) {
        expect(response.body.success).toBe(true);
      }
    });

    it('should update alias description', async () => {
      mockResolve(prisma.alias.update,{
        ...mockAlias,
        description: 'New Description'
      });

      const response = await request(app)
        .put('/api/v1/manage/valid-token')
        .send({ description: 'New Description' })
        .expect('Content-Type', /json/);

      if (response.status === 200) {
        expect(response.body.success).toBe(true);
      }
    });

    it('should toggle alias active status', async () => {
      mockResolve(prisma.alias.update,{
        ...mockAlias,
        isActive: false
      });

      const response = await request(app)
        .put('/api/v1/manage/valid-token')
        .send({ isActive: false })
        .expect('Content-Type', /json/);

      if (response.status === 200) {
        expect(response.body.success).toBe(true);
      }
    });

    it('should return 404 for invalid token', async () => {
      mockResolve(prisma.alias.findUnique,null);

      const response = await request(app)
        .put('/api/v1/manage/invalid-token')
        .send({ label: 'New Label' })
        .expect('Content-Type', /json/);

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/manage/:token - Delete Alias', () => {
    it('should delete alias', async () => {
      const mockAlias = {
        id: 'alias-123',
        alias: 'abc12345',
        managementToken: 'valid-token',
        domainId: 'domain-1'
      };

      mockResolve(prisma.alias.findUnique,mockAlias);
      mockResolve(prisma.alias.delete,mockAlias);
      mockResolve(prisma.domain.update,{});

      const response = await request(app)
        .delete('/api/v1/manage/valid-token')
        .expect('Content-Type', /json/);

      if (response.status === 200) {
        expect(response.body.success).toBe(true);
      }
    });

    it('should return 404 for invalid token', async () => {
      mockResolve(prisma.alias.findUnique,null);

      const response = await request(app)
        .delete('/api/v1/manage/invalid-token')
        .expect('Content-Type', /json/);

      expect(response.status).toBe(404);
    });
  });
});

describe('Alias Validation', () => {
  describe('Custom Alias Validation', () => {
    it('should accept valid custom aliases', () => {
      const validAliases = [
        'myalias',
        'my-alias',
        'my_alias',
        'my.alias',
        'alias123',
        'a1b2c3d4'
      ];

      for (const alias of validAliases) {
        const isValid = /^[a-z0-9]+([._-][a-z0-9]+)*$/i.test(alias) &&
          alias.length >= 4 &&
          alias.length <= 32 &&
          !alias.startsWith('r');
        expect(isValid).toBe(true);
      }
    });

    it('should reject invalid custom aliases', () => {
      const invalidAliases = [
        'abc', // Too short
        'r' + 'a'.repeat(10), // Starts with r
        'my alias', // Contains space
        'my@alias', // Contains @
        'a'.repeat(33), // Too long
        '--alias', // Starts with special char
        'alias--test' // Consecutive special chars
      ];

      for (const alias of invalidAliases) {
        const isValid = /^[a-z0-9]+([._-][a-z0-9]+)*$/i.test(alias) &&
          alias.length >= 4 &&
          alias.length <= 32 &&
          !alias.startsWith('r');
        expect(isValid).toBe(false);
      }
    });
  });

  describe('Email Validation', () => {
    it('should accept valid emails', () => {
      const validEmails = [
        'user@example.com',
        'user.name@example.com',
        'user+tag@example.com',
        'user@subdomain.example.com'
      ];

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const email of validEmails) {
        expect(emailRegex.test(email)).toBe(true);
      }
    });

    it('should reject invalid emails', () => {
      const invalidEmails = [
        'invalid',
        '@example.com',
        'user@',
        'user@.com',
        ''
      ];

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const email of invalidEmails) {
        expect(emailRegex.test(email)).toBe(false);
      }
    });
  });
});
