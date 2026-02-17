import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Get the master encryption key from environment
 * This key should NEVER be stored in the database
 */
function getMasterKey(): Buffer {
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;

  if (!masterKey) {
    throw new Error('MASTER_ENCRYPTION_KEY environment variable is not set');
  }

  // Support both hex and base64 encoded keys
  if (masterKey.length === 64) {
    // Hex encoded (64 chars = 32 bytes)
    return Buffer.from(masterKey, 'hex');
  } else if (masterKey.length === 44) {
    // Base64 encoded (44 chars = 32 bytes)
    return Buffer.from(masterKey, 'base64');
  } else {
    throw new Error('MASTER_ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars)');
  }
}

/**
 * Derive a unique key for each alias using HKDF
 * This ensures each alias has its own encryption key
 */
function deriveKey(aliasId: string, salt: Buffer): Buffer {
  const masterKey = getMasterKey();

  // Use HKDF to derive a unique key for this alias
  const derivedKey = crypto.hkdfSync(
    'sha256',
    masterKey,
    salt,
    `makeanon-alias-${aliasId}`,
    KEY_LENGTH
  );

  return Buffer.from(derivedKey);
}

export interface EncryptedData {
  ciphertext: string;  // Base64 encoded
  iv: string;          // Base64 encoded
  salt: string;        // Base64 encoded
  authTag: string;     // Base64 encoded
}

/**
 * Encrypt a destination email address
 * Returns encrypted data that can be stored in the database
 */
export function encryptEmail(email: string, aliasId: string): EncryptedData {
  // Generate random salt and IV
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // Derive key for this alias
  const key = deriveKey(aliasId, salt);

  // Encrypt the email
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(email, 'utf8', 'base64');
  ciphertext += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return {
    ciphertext,
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt a destination email address
 * Used when forwarding emails or displaying to the alias owner
 */
export function decryptEmail(encryptedData: EncryptedData, aliasId: string): string {
  const { ciphertext, iv, salt, authTag } = encryptedData;

  // Derive the same key using the stored salt
  const key = deriveKey(aliasId, Buffer.from(salt, 'base64'));

  // Decrypt the email
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'base64')
  );

  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  let email = decipher.update(ciphertext, 'base64', 'utf8');
  email += decipher.final('utf8');

  return email;
}

/**
 * Generate a new master encryption key
 * Run this once to generate a key for your .env file
 */
export function generateMasterKey(): { hex: string; base64: string } {
  const key = crypto.randomBytes(KEY_LENGTH);
  return {
    hex: key.toString('hex'),
    base64: key.toString('base64'),
  };
}

/**
 * Verify that the master key is configured correctly
 * Call this at application startup
 */
export function verifyEncryptionSetup(): boolean {
  try {
    getMasterKey();

    // Test encryption/decryption
    const testId = 'test-alias-id';
    const testEmail = 'test@example.com';

    const encrypted = encryptEmail(testEmail, testId);
    const decrypted = decryptEmail(encrypted, testId);

    if (decrypted !== testEmail) {
      throw new Error('Encryption verification failed: decrypted value does not match');
    }

    return true;
  } catch (error) {
    console.error('Encryption setup verification failed:', error);
    return false;
  }
}

/**
 * Re-encrypt an email with a new alias ID
 * Useful if we ever need to migrate data
 */
export function reencryptEmail(
  encryptedData: EncryptedData,
  oldAliasId: string,
  newAliasId: string
): EncryptedData {
  const email = decryptEmail(encryptedData, oldAliasId);
  return encryptEmail(email, newAliasId);
}

/**
 * Create a peppered hash of an email for lookups
 * Uses HMAC-SHA256 with the master key as pepper
 * This allows counting aliases per email without storing plaintext
 */
export function hashEmail(email: string): string {
  const masterKey = getMasterKey();
  const normalizedEmail = email.toLowerCase().trim();

  return crypto
    .createHmac('sha256', masterKey)
    .update(normalizedEmail)
    .digest('hex');
}

/**
 * Helper to check if encryption is enabled
 */
export function isEncryptionEnabled(): boolean {
  return !!process.env.MASTER_ENCRYPTION_KEY;
}
