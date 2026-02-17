/**
 * Encryption Utilities Unit Tests
 *
 * Tests for the encryption module that handles email encryption/decryption
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import {
  encryptEmail,
  decryptEmail,
  generateMasterKey,
  verifyEncryptionSetup,
  reencryptEmail,
  hashEmail,
  isEncryptionEnabled,
  EncryptedData
} from '../../../utils/encryption';

describe('Encryption Utilities', () => {
  // Store original env
  const originalEnv = process.env.MASTER_ENCRYPTION_KEY;

  beforeEach(() => {
    // Ensure encryption key is set for tests
    process.env.MASTER_ENCRYPTION_KEY = 'a57c3d7777b3ff668f12086b306cafa8168c541869a24f6806ec57699241ed7f';
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv) {
      process.env.MASTER_ENCRYPTION_KEY = originalEnv;
    }
  });

  describe('generateMasterKey', () => {
    it('should generate a valid 32-byte key in both hex and base64 formats', () => {
      const key = generateMasterKey();

      expect(key).toHaveProperty('hex');
      expect(key).toHaveProperty('base64');

      // Hex should be 64 characters (32 bytes * 2)
      expect(key.hex).toHaveLength(64);
      expect(/^[a-f0-9]+$/i.test(key.hex)).toBe(true);

      // Base64 should be 44 characters (32 bytes base64 encoded)
      expect(key.base64).toHaveLength(44);
    });

    it('should generate unique keys on each call', () => {
      const key1 = generateMasterKey();
      const key2 = generateMasterKey();

      expect(key1.hex).not.toBe(key2.hex);
      expect(key1.base64).not.toBe(key2.base64);
    });
  });

  describe('encryptEmail', () => {
    it('should encrypt an email and return encrypted data structure', () => {
      const email = 'test@example.com';
      const aliasId = 'alias-123';

      const encrypted = encryptEmail(email, aliasId);

      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('salt');
      expect(encrypted).toHaveProperty('authTag');

      // All values should be base64 encoded strings
      expect(typeof encrypted.ciphertext).toBe('string');
      expect(typeof encrypted.iv).toBe('string');
      expect(typeof encrypted.salt).toBe('string');
      expect(typeof encrypted.authTag).toBe('string');

      // Ciphertext should not be the same as original email
      expect(encrypted.ciphertext).not.toBe(email);
    });

    it('should produce different ciphertext for the same email with different alias IDs', () => {
      const email = 'test@example.com';

      const encrypted1 = encryptEmail(email, 'alias-1');
      const encrypted2 = encryptEmail(email, 'alias-2');

      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    });

    it('should produce different ciphertext for repeated encryptions of the same data', () => {
      const email = 'test@example.com';
      const aliasId = 'alias-123';

      const encrypted1 = encryptEmail(email, aliasId);
      const encrypted2 = encryptEmail(email, aliasId);

      // Due to random IV and salt, ciphertext should be different
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.salt).not.toBe(encrypted2.salt);
    });

    it('should handle emails with special characters', () => {
      const specialEmails = [
        'user+tag@example.com',
        'user.name@example.co.uk',
        'user@subdomain.example.com',
        '"quoted"@example.com',
        'user@example-domain.com'
      ];

      for (const email of specialEmails) {
        const encrypted = encryptEmail(email, 'alias-123');
        expect(encrypted.ciphertext).toBeTruthy();
      }
    });

    it('should handle long email addresses', () => {
      const longEmail = 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.com';
      const encrypted = encryptEmail(longEmail, 'alias-123');

      expect(encrypted.ciphertext).toBeTruthy();
    });
  });

  describe('decryptEmail', () => {
    it('should correctly decrypt an encrypted email', () => {
      const originalEmail = 'test@example.com';
      const aliasId = 'alias-123';

      const encrypted = encryptEmail(originalEmail, aliasId);
      const decrypted = decryptEmail(encrypted, aliasId);

      expect(decrypted).toBe(originalEmail);
    });

    it('should correctly decrypt emails with special characters', () => {
      const specialEmails = [
        'user+tag@example.com',
        'user.name@example.co.uk',
        '"quoted"@example.com',
        'user_name@example.com'
      ];

      for (const email of specialEmails) {
        const encrypted = encryptEmail(email, 'alias-123');
        const decrypted = decryptEmail(encrypted, 'alias-123');
        expect(decrypted).toBe(email);
      }
    });

    it('should fail to decrypt with wrong alias ID', () => {
      const email = 'test@example.com';
      const encrypted = encryptEmail(email, 'alias-correct');

      expect(() => {
        decryptEmail(encrypted, 'alias-wrong');
      }).toThrow();
    });

    it('should fail to decrypt with tampered ciphertext', () => {
      const email = 'test@example.com';
      const encrypted = encryptEmail(email, 'alias-123');

      // Tamper with the ciphertext
      const tampered: EncryptedData = {
        ...encrypted,
        ciphertext: 'tampered' + encrypted.ciphertext.slice(8)
      };

      expect(() => {
        decryptEmail(tampered, 'alias-123');
      }).toThrow();
    });

    it('should fail to decrypt with tampered authTag', () => {
      const email = 'test@example.com';
      const encrypted = encryptEmail(email, 'alias-123');

      // Tamper with the auth tag
      const tampered: EncryptedData = {
        ...encrypted,
        authTag: Buffer.from('tamperedauthtag!').toString('base64')
      };

      expect(() => {
        decryptEmail(tampered, 'alias-123');
      }).toThrow();
    });

    it('should fail to decrypt with tampered IV', () => {
      const email = 'test@example.com';
      const encrypted = encryptEmail(email, 'alias-123');

      // Tamper with the IV
      const tampered: EncryptedData = {
        ...encrypted,
        iv: Buffer.from('tamperediv123456').toString('base64')
      };

      expect(() => {
        decryptEmail(tampered, 'alias-123');
      }).toThrow();
    });
  });

  describe('reencryptEmail', () => {
    it('should successfully re-encrypt an email with a new alias ID', () => {
      const originalEmail = 'test@example.com';
      const oldAliasId = 'old-alias-123';
      const newAliasId = 'new-alias-456';

      const originalEncrypted = encryptEmail(originalEmail, oldAliasId);
      const reencrypted = reencryptEmail(originalEncrypted, oldAliasId, newAliasId);

      // Should be different encrypted data
      expect(reencrypted.ciphertext).not.toBe(originalEncrypted.ciphertext);

      // But should decrypt to the same email with new alias ID
      const decrypted = decryptEmail(reencrypted, newAliasId);
      expect(decrypted).toBe(originalEmail);

      // Should not decrypt with old alias ID
      expect(() => {
        decryptEmail(reencrypted, oldAliasId);
      }).toThrow();
    });
  });

  describe('hashEmail', () => {
    it('should produce a consistent hash for the same email', () => {
      const email = 'test@example.com';

      const hash1 = hashEmail(email);
      const hash2 = hashEmail(email);

      expect(hash1).toBe(hash2);
    });

    it('should produce a 64-character hex string', () => {
      const hash = hashEmail('test@example.com');

      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]+$/i.test(hash)).toBe(true);
    });

    it('should produce different hashes for different emails', () => {
      const hash1 = hashEmail('user1@example.com');
      const hash2 = hashEmail('user2@example.com');

      expect(hash1).not.toBe(hash2);
    });

    it('should normalize emails to lowercase before hashing', () => {
      const hash1 = hashEmail('Test@Example.COM');
      const hash2 = hashEmail('test@example.com');

      expect(hash1).toBe(hash2);
    });

    it('should trim whitespace before hashing', () => {
      const hash1 = hashEmail('  test@example.com  ');
      const hash2 = hashEmail('test@example.com');

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes with different master keys', () => {
      const email = 'test@example.com';
      const hash1 = hashEmail(email);

      // Change the master key
      process.env.MASTER_ENCRYPTION_KEY = 'b57c3d7777b3ff668f12086b306cafa8168c541869a24f6806ec57699241ed7f';
      const hash2 = hashEmail(email);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyEncryptionSetup', () => {
    it('should return true when encryption is properly configured', () => {
      const result = verifyEncryptionSetup();
      expect(result).toBe(true);
    });

    it('should return false when master key is not set', () => {
      delete process.env.MASTER_ENCRYPTION_KEY;

      const result = verifyEncryptionSetup();
      expect(result).toBe(false);
    });

    it('should return false when master key is invalid length', () => {
      process.env.MASTER_ENCRYPTION_KEY = 'too-short';

      const result = verifyEncryptionSetup();
      expect(result).toBe(false);
    });
  });

  describe('isEncryptionEnabled', () => {
    it('should return true when master key is set', () => {
      expect(isEncryptionEnabled()).toBe(true);
    });

    it('should return false when master key is not set', () => {
      delete process.env.MASTER_ENCRYPTION_KEY;

      expect(isEncryptionEnabled()).toBe(false);
    });

    it('should return false when master key is empty string', () => {
      process.env.MASTER_ENCRYPTION_KEY = '';

      expect(isEncryptionEnabled()).toBe(false);
    });
  });

  describe('Master Key Formats', () => {
    it('should accept hex-encoded master key (64 chars)', () => {
      process.env.MASTER_ENCRYPTION_KEY = 'a57c3d7777b3ff668f12086b306cafa8168c541869a24f6806ec57699241ed7f';

      const result = verifyEncryptionSetup();
      expect(result).toBe(true);
    });

    it('should accept base64-encoded master key (44 chars)', () => {
      // Generate a valid base64 key
      const key = generateMasterKey();
      process.env.MASTER_ENCRYPTION_KEY = key.base64;

      const result = verifyEncryptionSetup();
      expect(result).toBe(true);
    });

    it('should reject invalid key lengths', () => {
      process.env.MASTER_ENCRYPTION_KEY = 'invalid-length-key';

      const result = verifyEncryptionSetup();
      expect(result).toBe(false);
    });
  });

  describe('Security Properties', () => {
    it('should use authenticated encryption (GCM)', () => {
      const email = 'test@example.com';
      const encrypted = encryptEmail(email, 'alias-123');

      // Auth tag should be present and 16 bytes (22 base64 chars with padding)
      const authTagBuffer = Buffer.from(encrypted.authTag, 'base64');
      expect(authTagBuffer.length).toBe(16);
    });

    it('should use unique IV for each encryption', () => {
      const email = 'test@example.com';
      const ivs = new Set<string>();

      // Encrypt same email multiple times
      for (let i = 0; i < 100; i++) {
        const encrypted = encryptEmail(email, 'alias-123');
        expect(ivs.has(encrypted.iv)).toBe(false);
        ivs.add(encrypted.iv);
      }

      expect(ivs.size).toBe(100);
    });

    it('should use unique salt for each encryption', () => {
      const email = 'test@example.com';
      const salts = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const encrypted = encryptEmail(email, 'alias-123');
        expect(salts.has(encrypted.salt)).toBe(false);
        salts.add(encrypted.salt);
      }

      expect(salts.size).toBe(100);
    });

    it('should derive different keys for different aliases', () => {
      // This is implicitly tested by the fact that decryption fails with wrong alias ID
      const email = 'test@example.com';

      const enc1 = encryptEmail(email, 'alias-1');
      const enc2 = encryptEmail(email, 'alias-2');

      // Cross-decryption should fail
      expect(() => decryptEmail(enc1, 'alias-2')).toThrow();
      expect(() => decryptEmail(enc2, 'alias-1')).toThrow();

      // Same-alias decryption should work
      expect(decryptEmail(enc1, 'alias-1')).toBe(email);
      expect(decryptEmail(enc2, 'alias-2')).toBe(email);
    });
  });
});
