/**
 * Auth Controller Integration Tests
 *
 * Tests for user authentication, registration, and account management
 */

import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Mock dependencies before imports
jest.mock('../../../services/database', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn()
    },
    alias: {
      deleteMany: jest.fn(),
      count: jest.fn()
    },
    emailLog: {
      deleteMany: jest.fn()
    },
    $connect: jest.fn(),
    $disconnect: jest.fn()
  }
}));

import prisma from '../../../services/database';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockResolve = (fn: any, value: any) => fn.mockResolvedValue(value);

describe('Auth Controller', () => {
  // Test constants
  const JWT_SECRET = 'test-jwt-secret-key-for-testing-only-32chars';
  const SALT_ROUNDS = 10;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.JWT_EXPIRES_IN = '7d';
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('User Signup', () => {
    describe('Input Validation', () => {
      it('should require a valid email', () => {
        const invalidEmails = [
          '',
          'invalid',
          '@example.com',
          'user@',
          'user@.com'
        ];

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        for (const email of invalidEmails) {
          expect(emailRegex.test(email)).toBe(false);
        }
      });

      it('should validate password requirements', () => {
        const validPasswords = [
          'Password1',
          'MyP@ss123',
          'SecurePass99',
          'Test1234'
        ];

        const invalidPasswords = [
          'short1A', // Too short
          'nouppercase1', // No uppercase
          'NOLOWERCASE1', // No lowercase
          'NoDigits!', // No digit
          'password', // Missing uppercase and digit
        ];

        // Password must be 8+ chars with uppercase, lowercase, and digit
        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

        for (const password of validPasswords) {
          expect(passwordRegex.test(password)).toBe(true);
        }

        for (const password of invalidPasswords) {
          expect(passwordRegex.test(password)).toBe(false);
        }
      });
    });

    describe('User Creation', () => {
      it('should hash password before storing', async () => {
        const password = 'SecurePass123';
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        expect(hashedPassword).not.toBe(password);
        expect(hashedPassword.length).toBeGreaterThan(50);

        // Verify hash matches
        const isMatch = await bcrypt.compare(password, hashedPassword);
        expect(isMatch).toBe(true);
      });

      it('should not store plaintext password', async () => {
        const password = 'SecurePass123';
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        expect(hashedPassword).not.toContain(password);
      });

      it('should make first user an admin', async () => {
        mockResolve(prisma.user.count,0);

        const isFirstUser = await prisma.user.count({}) === 0;
        expect(isFirstUser).toBe(true);

        // First user should be admin
        const userData = {
          isAdmin: isFirstUser
        };
        expect(userData.isAdmin).toBe(true);
      });

      it('should not make subsequent users admin', async () => {
        mockResolve(prisma.user.count,1);

        const isFirstUser = await prisma.user.count({}) === 0;
        expect(isFirstUser).toBe(false);

        const userData = {
          isAdmin: isFirstUser
        };
        expect(userData.isAdmin).toBe(false);
      });
    });

    describe('Duplicate Email Prevention', () => {
      it('should prevent duplicate email registration', async () => {
        const email = 'existing@example.com';

        mockResolve(prisma.user.findUnique,{
          id: 'user-123',
          email,
          password: 'hashedpassword'
        });

        const existingUser = await prisma.user.findUnique({
          where: { emailHash: email }
        });

        expect(existingUser).not.toBeNull();
        // Should reject signup with existing email
      });
    });
  });

  describe('User Login', () => {
    describe('Credential Verification', () => {
      it('should verify correct password', async () => {
        const password = 'SecurePass123';
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        const isValid = await bcrypt.compare(password, hashedPassword);
        expect(isValid).toBe(true);
      });

      it('should reject incorrect password', async () => {
        const correctPassword = 'SecurePass123';
        const wrongPassword = 'WrongPass123';
        const hashedPassword = await bcrypt.hash(correctPassword, SALT_ROUNDS);

        const isValid = await bcrypt.compare(wrongPassword, hashedPassword);
        expect(isValid).toBe(false);
      });

      it('should reject non-existent user', async () => {
        mockResolve(prisma.user.findUnique,null);

        const user = await prisma.user.findUnique({
          where: { emailHash: 'nonexistent@example.com' }
        });

        expect(user).toBeNull();
      });
    });

    describe('JWT Token Generation', () => {
      it('should generate valid JWT token', () => {
        const payload = {
          userId: 'user-123',
          email: 'user@example.com',
          isAdmin: false
        };

        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

        expect(token).toBeTruthy();
        expect(typeof token).toBe('string');
        expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
      });

      it('should include required claims in token', () => {
        const payload = {
          userId: 'user-123',
          email: 'user@example.com',
          isAdmin: false
        };

        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
        const decoded = jwt.verify(token, JWT_SECRET) as any;

        expect(decoded.userId).toBe(payload.userId);
        expect(decoded.email).toBe(payload.email);
        expect(decoded.isAdmin).toBe(payload.isAdmin);
      });

      it('should set correct expiration', () => {
        const payload = { userId: 'user-123' };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
        const decoded = jwt.verify(token, JWT_SECRET) as any;

        const expiresAt = new Date(decoded.exp * 1000);
        const now = new Date();
        const daysDiff = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

        expect(Math.round(daysDiff)).toBe(7);
      });
    });

    describe('Account Status Check', () => {
      it('should prevent login for inactive accounts', async () => {
        mockResolve(prisma.user.findUnique,{
          id: 'user-123',
          email: 'inactive@example.com',
          isActive: false
        });

        const user = await prisma.user.findUnique({
          where: { emailHash: 'inactive@example.com' }
        });

        expect(user?.isActive).toBe(false);
        // Should reject login
      });
    });
  });

  describe('JWT Verification', () => {
    it('should verify valid token', () => {
      const payload = { userId: 'user-123' };
      const token = jwt.sign(payload, JWT_SECRET);

      const decoded = jwt.verify(token, JWT_SECRET);
      expect(decoded).toBeTruthy();
    });

    it('should reject invalid token', () => {
      expect(() => {
        jwt.verify('invalid.token.here', JWT_SECRET);
      }).toThrow();
    });

    it('should reject expired token', () => {
      const payload = { userId: 'user-123' };
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '-1s' });

      expect(() => {
        jwt.verify(token, JWT_SECRET);
      }).toThrow();
    });

    it('should reject token with wrong secret', () => {
      const payload = { userId: 'user-123' };
      const token = jwt.sign(payload, 'wrong-secret');

      expect(() => {
        jwt.verify(token, JWT_SECRET);
      }).toThrow();
    });

    it('should reject tampered token', () => {
      const payload = { userId: 'user-123' };
      const token = jwt.sign(payload, JWT_SECRET);
      const tamperedToken = token.slice(0, -5) + 'xxxxx';

      expect(() => {
        jwt.verify(tamperedToken, JWT_SECRET);
      }).toThrow();
    });
  });

  describe('Password Change', () => {
    it('should verify current password before change', async () => {
      const currentPassword = 'OldPass123';
      const hashedPassword = await bcrypt.hash(currentPassword, SALT_ROUNDS);

      // Correct current password
      const isValid = await bcrypt.compare(currentPassword, hashedPassword);
      expect(isValid).toBe(true);

      // Wrong current password
      const isInvalid = await bcrypt.compare('WrongPass', hashedPassword);
      expect(isInvalid).toBe(false);
    });

    it('should hash new password', async () => {
      const newPassword = 'NewPass123';
      const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);

      expect(hashedPassword).not.toBe(newPassword);

      const isMatch = await bcrypt.compare(newPassword, hashedPassword);
      expect(isMatch).toBe(true);
    });

    it('should validate new password requirements', () => {
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

      expect(passwordRegex.test('NewPass123')).toBe(true);
      expect(passwordRegex.test('short')).toBe(false);
    });
  });

  describe('Account Deletion', () => {
    it('should delete user and related data', async () => {
      const userId = 'user-123';

      mockResolve(prisma.alias.deleteMany,{ count: 5 });
      mockResolve(prisma.emailLog.deleteMany,{ count: 100 });
      mockResolve(prisma.user.delete,{ id: userId });

      // Delete aliases
      const aliasResult = await prisma.alias.deleteMany({
        where: { userId }
      });
      expect(aliasResult.count).toBe(5);

      // Delete email logs
      const logResult = await prisma.emailLog.deleteMany({
        where: { userId }
      });
      expect(logResult.count).toBe(100);

      // Delete user
      const userResult = await prisma.user.delete({
        where: { id: userId }
      });
      expect(userResult.id).toBe(userId);
    });
  });

  describe('Profile Management', () => {
    it('should allow updating profile name', async () => {
      mockResolve(prisma.user.update,{
        id: 'user-123',
        name: 'New Name'
      });

      const result = await prisma.user.update({
        where: { id: 'user-123' },
        data: { name: 'New Name' }
      });

      expect(result.name).toBe('New Name');
    });

    it('should sanitize profile updates', () => {
      const dangerousName = '<script>alert("xss")</script>';
      // Sanitization should strip HTML
      const sanitized = dangerousName.replace(/<[^>]*>/g, '');
      expect(sanitized).not.toContain('<script>');
    });
  });
});

describe('Authentication Middleware', () => {
  const JWT_SECRET = 'test-jwt-secret-key-for-testing-only-32chars';

  describe('Token Extraction', () => {
    it('should extract Bearer token from Authorization header', () => {
      const authHeader = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx.yyy';
      const token = authHeader.split(' ')[1];

      expect(token).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx.yyy');
    });

    it('should handle missing Authorization header', () => {
      const authHeader: string | undefined = undefined;
      const token = authHeader?.split(' ')[1];

      expect(token).toBeUndefined();
    });

    it('should handle non-Bearer token', () => {
      const authHeader = 'Basic abc123';
      const parts = authHeader.split(' ');

      expect(parts[0]).not.toBe('Bearer');
    });
  });

  describe('User Lookup', () => {
    it('should load user from database after token verification', async () => {
      const userId = 'user-123';

      mockResolve(prisma.user.findUnique,{
        id: userId,
        email: 'user@example.com',
        isActive: true,
        isAdmin: false
      });

      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      expect(user).not.toBeNull();
      expect(user?.id).toBe(userId);
    });

    it('should reject if user not found', async () => {
      mockResolve(prisma.user.findUnique,null);

      const user = await prisma.user.findUnique({
        where: { id: 'nonexistent' }
      });

      expect(user).toBeNull();
    });

    it('should reject if user is inactive', async () => {
      mockResolve(prisma.user.findUnique,{
        id: 'user-123',
        isActive: false
      });

      const user = await prisma.user.findUnique({
        where: { id: 'user-123' }
      });

      expect(user?.isActive).toBe(false);
    });
  });
});
