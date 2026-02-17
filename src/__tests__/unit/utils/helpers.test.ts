/**
 * Helper Utilities Unit Tests
 *
 * Tests for all helper functions used across the application
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  generateAlias,
  generateSecureToken,
  generateManagementToken,
  generateReplyPrefix,
  hashString,
  getEmailDomains,
  getDefaultDomain,
  isValidAliasDomain,
  createFullAliasEmail,
  parseAliasEmail,
  isReplyAddress,
  isValidEmail,
  isValidCustomAlias,
  sanitizeForLog,
  parseEmailAddress,
  getBaseUrl,
  createManagementUrl,
  createVerificationUrl,
  calculateExpiresAt,
  isExpired,
  formatDate,
  sleep,
  retryWithBackoff,
  isDisposableEmail
} from '../../../utils/helpers';

describe('Helper Utilities', () => {
  // Store original env values
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set test environment
    process.env.EMAIL_DOMAINS = 'test.example.com,alias.test.com';
    process.env.BASE_URL = 'https://test.example.com';
    process.env.PORT = '3000';
    process.env.ALIAS_LENGTH = '8';
    process.env.MIN_CUSTOM_ALIAS_LENGTH = '4';
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe('generateAlias', () => {
    it('should generate an alias of default length (8)', () => {
      const alias = generateAlias();
      expect(alias).toHaveLength(8);
    });

    it('should generate an alias of custom length', () => {
      const alias = generateAlias(12);
      expect(alias).toHaveLength(12);
    });

    it('should only contain valid characters (lowercase alphanumeric)', () => {
      const alias = generateAlias();
      expect(/^[a-z0-9]+$/.test(alias)).toBe(true);
    });

    it('should not contain confusing characters (l, 1, 0)', () => {
      // Generate many aliases to check
      // Note: 'o' is kept in the alphabet because aliases are always lowercase,
      // so there is no O/0 confusion (uppercase O is never generated)
      for (let i = 0; i < 100; i++) {
        const alias = generateAlias(20);
        expect(alias).not.toMatch(/[l10]/);
      }
    });

    it('should generate unique aliases', () => {
      const aliases = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        aliases.add(generateAlias());
      }
      expect(aliases.size).toBe(1000);
    });

    it('should respect ALIAS_LENGTH environment variable', () => {
      process.env.ALIAS_LENGTH = '10';
      const alias = generateAlias();
      expect(alias).toHaveLength(10);
    });
  });

  describe('generateSecureToken', () => {
    it('should generate a 64-character hex string by default (32 bytes)', () => {
      const token = generateSecureToken();
      expect(token).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(token)).toBe(true);
    });

    it('should generate tokens of custom length', () => {
      const token = generateSecureToken(16);
      expect(token).toHaveLength(32); // 16 bytes = 32 hex chars
    });

    it('should generate unique tokens', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateSecureToken());
      }
      expect(tokens.size).toBe(100);
    });
  });

  describe('generateManagementToken', () => {
    it('should generate a 48-character hex string (24 bytes)', () => {
      const token = generateManagementToken();
      expect(token).toHaveLength(48);
      expect(/^[a-f0-9]+$/.test(token)).toBe(true);
    });
  });

  describe('generateReplyPrefix', () => {
    it('should generate a 13-character string starting with r', () => {
      const prefix = generateReplyPrefix();
      expect(prefix).toHaveLength(13);
      expect(prefix.startsWith('r')).toBe(true);
    });

    it('should only contain valid characters after r', () => {
      const prefix = generateReplyPrefix();
      expect(/^r[a-z0-9]+$/.test(prefix)).toBe(true);
    });

    it('should generate unique prefixes', () => {
      const prefixes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        prefixes.add(generateReplyPrefix());
      }
      expect(prefixes.size).toBe(100);
    });
  });

  describe('hashString', () => {
    it('should return a 64-character SHA256 hex hash', () => {
      const hash = hashString('test');
      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
    });

    it('should return consistent hashes for the same input', () => {
      const hash1 = hashString('test');
      const hash2 = hashString('test');
      expect(hash1).toBe(hash2);
    });

    it('should return different hashes for different inputs', () => {
      const hash1 = hashString('test1');
      const hash2 = hashString('test2');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty strings', () => {
      const hash = hashString('');
      expect(hash).toHaveLength(64);
    });

    it('should handle unicode characters', () => {
      const hash = hashString('测试emoji🎉');
      expect(hash).toHaveLength(64);
    });
  });

  describe('getEmailDomains', () => {
    it('should return configured domains', () => {
      const domains = getEmailDomains();
      expect(domains).toEqual(['test.example.com', 'alias.test.com']);
    });

    it('should return default domain if not configured', () => {
      delete process.env.EMAIL_DOMAINS;
      const domains = getEmailDomains();
      expect(domains).toEqual(['mask.example.com']);
    });

    it('should normalize domains to lowercase', () => {
      process.env.EMAIL_DOMAINS = 'TEST.Example.COM';
      const domains = getEmailDomains();
      expect(domains).toEqual(['test.example.com']);
    });

    it('should trim whitespace from domains', () => {
      process.env.EMAIL_DOMAINS = '  test.com  ,  alias.com  ';
      const domains = getEmailDomains();
      expect(domains).toEqual(['test.com', 'alias.com']);
    });
  });

  describe('getDefaultDomain', () => {
    it('should return the first configured domain', () => {
      const domain = getDefaultDomain();
      expect(domain).toBe('test.example.com');
    });
  });

  describe('isValidAliasDomain', () => {
    it('should return true for valid domains', () => {
      expect(isValidAliasDomain('test.example.com')).toBe(true);
      expect(isValidAliasDomain('alias.test.com')).toBe(true);
    });

    it('should return false for invalid domains', () => {
      expect(isValidAliasDomain('invalid.com')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isValidAliasDomain('TEST.EXAMPLE.COM')).toBe(true);
    });
  });

  describe('createFullAliasEmail', () => {
    it('should create full email with default domain', () => {
      const email = createFullAliasEmail('myalias');
      expect(email).toBe('myalias@test.example.com');
    });

    it('should create full email with specified domain', () => {
      const email = createFullAliasEmail('myalias', 'alias.test.com');
      expect(email).toBe('myalias@alias.test.com');
    });

    it('should lowercase the alias', () => {
      const email = createFullAliasEmail('MyAlias');
      expect(email).toBe('myalias@test.example.com');
    });
  });

  describe('parseAliasEmail', () => {
    it('should parse valid alias email', () => {
      const result = parseAliasEmail('myalias@test.example.com');
      expect(result).toEqual({ alias: 'myalias', domain: 'test.example.com' });
    });

    it('should return null for invalid domain', () => {
      const result = parseAliasEmail('myalias@invalid.com');
      expect(result).toBeNull();
    });

    it('should return null for malformed email', () => {
      expect(parseAliasEmail('not-an-email')).toBeNull();
      expect(parseAliasEmail('multiple@at@signs.com')).toBeNull();
    });

    it('should normalize to lowercase', () => {
      const result = parseAliasEmail('MyAlias@TEST.EXAMPLE.COM');
      expect(result).toEqual({ alias: 'myalias', domain: 'test.example.com' });
    });
  });

  describe('isReplyAddress', () => {
    it('should return true for valid reply addresses', () => {
      // Reply prefix is 'r' + 12 chars = 13 total
      expect(isReplyAddress('rabcdefghijkl@test.example.com')).toBe(true);
    });

    it('should return false for non-reply addresses', () => {
      expect(isReplyAddress('myalias@test.example.com')).toBe(false);
      expect(isReplyAddress('abc@test.example.com')).toBe(false);
    });

    it('should return false for wrong length reply-like addresses', () => {
      expect(isReplyAddress('r12345@test.example.com')).toBe(false); // Too short
      expect(isReplyAddress('r12345678901234@test.example.com')).toBe(false); // Too long
    });

    it('should return false for invalid domains', () => {
      expect(isReplyAddress('rabcdefghijkl@invalid.com')).toBe(false);
    });
  });

  describe('isValidEmail', () => {
    it('should return true for valid emails', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
      expect(isValidEmail('user.name@example.com')).toBe(true);
      expect(isValidEmail('user+tag@example.com')).toBe(true);
      expect(isValidEmail('user@subdomain.example.com')).toBe(true);
    });

    it('should return false for invalid emails', () => {
      expect(isValidEmail('not-an-email')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
      expect(isValidEmail('user@')).toBe(false);
      expect(isValidEmail('user@.com')).toBe(false);
      expect(isValidEmail('')).toBe(false);
    });
  });

  describe('isValidCustomAlias', () => {
    it('should return true for valid custom aliases', () => {
      expect(isValidCustomAlias('myalias')).toBe(true);
      expect(isValidCustomAlias('my-alias')).toBe(true);
      expect(isValidCustomAlias('my_alias')).toBe(true);
      expect(isValidCustomAlias('my.alias')).toBe(true);
      expect(isValidCustomAlias('alias123')).toBe(true);
    });

    it('should return false for aliases starting with r (reserved)', () => {
      expect(isValidCustomAlias('ralias')).toBe(false);
    });

    it('should return false for too short aliases', () => {
      expect(isValidCustomAlias('abc')).toBe(false); // Less than MIN_CUSTOM_ALIAS_LENGTH (4)
    });

    it('should return false for too long aliases', () => {
      expect(isValidCustomAlias('a'.repeat(33))).toBe(false); // More than 32 chars
    });

    it('should return false for aliases with invalid characters', () => {
      expect(isValidCustomAlias('my alias')).toBe(false); // Space
      expect(isValidCustomAlias('my@alias')).toBe(false); // @
      expect(isValidCustomAlias('my#alias')).toBe(false); // #
    });

    it('should return false for aliases with consecutive special chars', () => {
      expect(isValidCustomAlias('my--alias')).toBe(false);
      expect(isValidCustomAlias('my..alias')).toBe(false);
      expect(isValidCustomAlias('my.-alias')).toBe(false);
    });
  });

  describe('sanitizeForLog', () => {
    it('should truncate long strings', () => {
      const long = 'a'.repeat(200);
      const sanitized = sanitizeForLog(long);
      expect(sanitized).toHaveLength(100);
    });

    it('should replace newlines with spaces', () => {
      const withNewlines = 'line1\nline2\rline3';
      const sanitized = sanitizeForLog(withNewlines);
      expect(sanitized).toBe('line1 line2 line3');
    });

    it('should respect custom max length', () => {
      const sanitized = sanitizeForLog('hello world', 5);
      expect(sanitized).toBe('hello');
    });
  });

  describe('parseEmailAddress', () => {
    it('should parse simple email addresses', () => {
      const result = parseEmailAddress('user@example.com');
      expect(result).toEqual({ name: null, email: 'user@example.com' });
    });

    it('should parse email with display name', () => {
      const result = parseEmailAddress('John Doe <john@example.com>');
      expect(result).toEqual({ name: 'John Doe', email: 'john@example.com' });
    });

    it('should parse quoted display name', () => {
      const result = parseEmailAddress('"John Doe" <john@example.com>');
      expect(result).toEqual({ name: 'John Doe', email: 'john@example.com' });
    });

    it('should normalize email to lowercase', () => {
      const result = parseEmailAddress('User@EXAMPLE.COM');
      expect(result.email).toBe('user@example.com');
    });

    it('should trim whitespace', () => {
      const result = parseEmailAddress('  user@example.com  ');
      expect(result.email).toBe('user@example.com');
    });
  });

  describe('URL helpers', () => {
    describe('getBaseUrl', () => {
      it('should return BASE_URL if set', () => {
        expect(getBaseUrl()).toBe('https://test.example.com');
      });

      it('should return localhost URL if BASE_URL not set', () => {
        delete process.env.BASE_URL;
        expect(getBaseUrl()).toBe('http://localhost:3000');
      });
    });

    describe('createManagementUrl', () => {
      it('should create management URL with token', () => {
        const url = createManagementUrl('abc123');
        expect(url).toBe('https://test.example.com/manage/abc123');
      });
    });

    describe('createVerificationUrl', () => {
      it('should create verification URL with token', () => {
        const url = createVerificationUrl('xyz789');
        expect(url).toBe('https://test.example.com/api/v1/verify/xyz789');
      });
    });
  });

  describe('Date/Time helpers', () => {
    describe('calculateExpiresAt', () => {
      it('should calculate future date correctly', () => {
        const now = new Date();
        const expiresAt = calculateExpiresAt(7);

        const diff = expiresAt.getTime() - now.getTime();
        const daysDiff = diff / (1000 * 60 * 60 * 24);

        expect(Math.round(daysDiff)).toBe(7);
      });

      it('should handle 0 days', () => {
        const now = new Date();
        const expiresAt = calculateExpiresAt(0);

        expect(expiresAt.getDate()).toBe(now.getDate());
      });
    });

    describe('isExpired', () => {
      it('should return true for past dates', () => {
        const pastDate = new Date('2020-01-01');
        expect(isExpired(pastDate)).toBe(true);
      });

      it('should return false for future dates', () => {
        const futureDate = new Date('2099-01-01');
        expect(isExpired(futureDate)).toBe(false);
      });

      it('should return false for null', () => {
        expect(isExpired(null)).toBe(false);
      });
    });

    describe('formatDate', () => {
      it('should return ISO formatted date string', () => {
        const date = new Date('2024-01-15T12:30:00Z');
        const formatted = formatDate(date);
        expect(formatted).toBe('2024-01-15T12:30:00.000Z');
      });
    });
  });

  describe('sleep', () => {
    it('should delay execution', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(95); // Allow small variance
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('retryWithBackoff', () => {
    it('should return result on first success', async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('success');

      const result = await retryWithBackoff(fn, 3, 10);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      const fn = jest.fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('fail1'))
        .mockRejectedValueOnce(new Error('fail2'))
        .mockResolvedValue('success');

      const result = await retryWithBackoff(fn, 3, 10);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries', async () => {
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('always fails'));

      await expect(retryWithBackoff(fn, 3, 10)).rejects.toThrow('always fails');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should use exponential backoff', async () => {
      const fn = jest.fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');

      const start = Date.now();
      await retryWithBackoff(fn, 3, 50);
      const elapsed = Date.now() - start;

      // First retry after 50ms
      expect(elapsed).toBeGreaterThanOrEqual(45);
    });
  });

  describe('isDisposableEmail', () => {
    it('should return true for known disposable domains', () => {
      expect(isDisposableEmail('user@tempmail.com')).toBe(true);
      expect(isDisposableEmail('user@mailinator.com')).toBe(true);
      expect(isDisposableEmail('user@guerrillamail.com')).toBe(true);
    });

    it('should return false for regular domains', () => {
      expect(isDisposableEmail('user@gmail.com')).toBe(false);
      expect(isDisposableEmail('user@company.com')).toBe(false);
      expect(isDisposableEmail('user@outlook.com')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isDisposableEmail('user@TEMPMAIL.COM')).toBe(true);
    });

    it('should handle invalid email format', () => {
      expect(isDisposableEmail('not-an-email')).toBe(false);
    });
  });
});
