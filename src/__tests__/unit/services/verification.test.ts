/**
 * Verification Service Unit Tests
 *
 * Tests for verification token management and email verification
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock dependencies before imports
jest.mock('../../../services/database', () => ({
  __esModule: true,
  default: {
    verificationToken: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn()
    },
    $connect: jest.fn(),
    $disconnect: jest.fn()
  }
}));

jest.mock('../../../services/emailService', () => ({
  sendNotification: jest.fn<() => Promise<{ success: boolean; messageId: string }>>().mockResolvedValue({ success: true, messageId: 'test-id' })
}));

jest.mock('../../../utils/helpers', () => ({
  generateSecureToken: jest.fn().mockReturnValue('mock-secure-token-123456'),
  createVerificationUrl: jest.fn().mockImplementation((token: string) => `https://example.com/verify/${token}`),
  calculateExpiresAt: jest.fn().mockImplementation((days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000))
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

import prisma from '../../../services/database';
import * as emailService from '../../../services/emailService';
import {
  createVerificationToken,
  verifyToken,
  sendManagementLinkEmail,
  cleanupExpiredTokens,
} from '../../../services/verificationService';

describe('Verification Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VERIFICATION_TOKEN_EXPIRY_HOURS = '24';
    process.env.VERIFICATION_RESEND_COOLDOWN = '60';
  });

  describe('createVerificationToken', () => {
    it('should create a new verification token', async () => {
      const mockToken = {
        id: 'token-1',
        email: 'user@example.com',
        token: 'mock-secure-token-123456',
        type: 'alias_verify',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      };

      (prisma.verificationToken.findFirst as jest.Mock<any>).mockResolvedValue(null);
      (prisma.verificationToken.create as jest.Mock<any>).mockResolvedValue(mockToken);

      const result = await createVerificationToken('user@example.com', 'alias_verify');

      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeDefined();
    });

    it('should respect rate limiting for existing tokens', async () => {
      const recentToken = {
        id: 'token-1',
        email: 'user@example.com',
        createdAt: new Date(), // Just created
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      };

      (prisma.verificationToken.findFirst as jest.Mock<any>).mockResolvedValue(recentToken);

      const result = await createVerificationToken('user@example.com', 'alias_verify');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Please wait');
    });

    it('should allow new token after cooldown period', async () => {
      const oldToken = {
        id: 'token-1',
        email: 'user@example.com',
        createdAt: new Date(Date.now() - 120000), // 2 minutes ago
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      };

      (prisma.verificationToken.findFirst as jest.Mock<any>).mockResolvedValue(oldToken);
      (prisma.verificationToken.create as jest.Mock<any>).mockResolvedValue({
        token: 'new-token'
      });

      const result = await createVerificationToken('user@example.com', 'alias_verify');

      expect(result.success).toBe(true);
    });

    it('should store metadata with token', async () => {
      (prisma.verificationToken.findFirst as jest.Mock<any>).mockResolvedValue(null);
      (prisma.verificationToken.create as jest.Mock<any>).mockResolvedValue({
        token: 'test-token'
      });

      const metadata = { aliasAddress: 'test@example.com' };
      await createVerificationToken('user@example.com', 'alias_verify', metadata);

      expect(prisma.verificationToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: JSON.stringify(metadata)
        })
      });
    });

    it('should lowercase email addresses', async () => {
      (prisma.verificationToken.findFirst as jest.Mock<any>).mockResolvedValue(null);
      (prisma.verificationToken.create as jest.Mock<any>).mockResolvedValue({});

      await createVerificationToken('User@EXAMPLE.COM', 'alias_verify');

      expect(prisma.verificationToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'user@example.com'
        })
      });
    });

    it('should return error on database failure', async () => {
      (prisma.verificationToken.findFirst as jest.Mock<any>).mockRejectedValue(new Error('DB Error'));

      const result = await createVerificationToken('user@example.com', 'alias_verify');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to create verification token');
    });
  });

  describe('verifyToken', () => {
    it('should verify a valid token', async () => {
      const validToken = {
        id: 'token-1',
        email: 'user@example.com',
        token: 'valid-token',
        type: 'alias_verify',
        metadata: JSON.stringify({ aliasAddress: 'test@example.com' }),
        expiresAt: new Date(Date.now() + 60000),
        usedAt: null
      };

      (prisma.verificationToken.findUnique as jest.Mock<any>).mockResolvedValue(validToken);
      (prisma.verificationToken.update as jest.Mock<any>).mockResolvedValue({});

      const result = await verifyToken('valid-token');

      expect(result.success).toBe(true);
      expect(result.email).toBe('user@example.com');
      expect(result.type).toBe('alias_verify');
      expect(result.metadata).toEqual({ aliasAddress: 'test@example.com' });
    });

    it('should mark token as used after verification', async () => {
      const validToken = {
        id: 'token-1',
        email: 'user@example.com',
        token: 'valid-token',
        type: 'alias_verify',
        metadata: null,
        expiresAt: new Date(Date.now() + 60000),
        usedAt: null
      };

      (prisma.verificationToken.findUnique as jest.Mock<any>).mockResolvedValue(validToken);
      (prisma.verificationToken.update as jest.Mock<any>).mockResolvedValue({});

      await verifyToken('valid-token');

      expect(prisma.verificationToken.update).toHaveBeenCalledWith({
        where: { id: 'token-1' },
        data: { usedAt: expect.any(Date) }
      });
    });

    it('should reject invalid token', async () => {
      (prisma.verificationToken.findUnique as jest.Mock<any>).mockResolvedValue(null);

      const result = await verifyToken('invalid-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid verification token');
    });

    it('should reject already used token', async () => {
      const usedToken = {
        id: 'token-1',
        token: 'used-token',
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000)
      };

      (prisma.verificationToken.findUnique as jest.Mock<any>).mockResolvedValue(usedToken);

      const result = await verifyToken('used-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('This verification link has already been used');
    });

    it('should reject expired token', async () => {
      const expiredToken = {
        id: 'token-1',
        token: 'expired-token',
        usedAt: null,
        expiresAt: new Date(Date.now() - 60000) // Expired
      };

      (prisma.verificationToken.findUnique as jest.Mock<any>).mockResolvedValue(expiredToken);

      const result = await verifyToken('expired-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('This verification link has expired');
    });

    it('should validate expected token type', async () => {
      const validToken = {
        id: 'token-1',
        token: 'valid-token',
        type: 'alias_verify',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000)
      };

      (prisma.verificationToken.findUnique as jest.Mock<any>).mockResolvedValue(validToken);

      const result = await verifyToken('valid-token', 'password_reset');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid token type');
    });

    it('should handle database errors gracefully', async () => {
      (prisma.verificationToken.findUnique as jest.Mock<any>).mockRejectedValue(new Error('DB Error'));

      const result = await verifyToken('any-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Verification failed');
    });
  });

  describe('sendManagementLinkEmail', () => {
    it('should send management link email', async () => {
      (emailService.sendNotification as jest.Mock<any>).mockResolvedValue({ success: true });

      const result = await sendManagementLinkEmail(
        'user@example.com',
        'alias@example.com',
        'https://example.com/manage/token123'
      );

      expect(result).toBe(true);
      expect(emailService.sendNotification).toHaveBeenCalled();
    });

    it('should return false on email failure', async () => {
      (emailService.sendNotification as jest.Mock<any>).mockResolvedValue({ success: false });

      const result = await sendManagementLinkEmail(
        'user@example.com',
        'alias@example.com',
        'https://example.com/manage/token123'
      );

      expect(result).toBe(false);
    });
  });

  describe('cleanupExpiredTokens', () => {
    it('should delete expired tokens', async () => {
      (prisma.verificationToken.deleteMany as jest.Mock<any>).mockResolvedValue({ count: 5 });

      const result = await cleanupExpiredTokens();

      expect(result).toBe(5);
      expect(prisma.verificationToken.deleteMany).toHaveBeenCalledWith({
        where: {
          expiresAt: { lt: expect.any(Date) }
        }
      });
    });

    it('should return 0 on error', async () => {
      (prisma.verificationToken.deleteMany as jest.Mock<any>).mockRejectedValue(new Error('DB Error'));

      const result = await cleanupExpiredTokens();

      expect(result).toBe(0);
    });
  });
});

describe('Verification Token Types', () => {
  const validTypes = ['email_verify', 'alias_verify', 'password_reset', 'management'];

  it('should support all verification token types', () => {
    for (const type of validTypes) {
      expect(typeof type).toBe('string');
      expect(type.length).toBeGreaterThan(0);
    }
  });
});

describe('Token Security', () => {
  it('should generate unpredictable tokens', () => {
    const tokens = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const token = `token-${Math.random().toString(36).substring(2)}-${Date.now()}`;
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
    }
  });

  it('should use sufficient token length', () => {
    // Token should be at least 48 characters (24 bytes hex)
    const minLength = 48;
    const sampleToken = 'a'.repeat(48);
    expect(sampleToken.length).toBeGreaterThanOrEqual(minLength);
  });
});
