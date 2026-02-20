/**
 * Encryption Key Rotation Script
 *
 * Re-encrypts all alias destination emails and user emails with a new master key.
 * Also recomputes all HMAC hashes (destinationHash, emailHash).
 *
 * Usage:
 *   OLD_MASTER_ENCRYPTION_KEY=<old-key> MASTER_ENCRYPTION_KEY=<new-key> npx ts-node scripts/rotate-key.ts
 *
 * IMPORTANT:
 * - Back up your database BEFORE running this script
 * - Set OLD_MASTER_ENCRYPTION_KEY to your current key
 * - Set MASTER_ENCRYPTION_KEY to the new key
 * - Run during a maintenance window (emails won't forward correctly during rotation)
 */

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

function parseKey(keyStr: string): Buffer {
  if (keyStr.length === 64) return Buffer.from(keyStr, 'hex');
  if (keyStr.length === 44) return Buffer.from(keyStr, 'base64');
  throw new Error('Key must be 32 bytes (64 hex chars or 44 base64 chars)');
}

function deriveKey(masterKey: Buffer, contextId: string, salt: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', masterKey, salt, `makeanon-alias-${contextId}`, KEY_LENGTH)
  );
}

function decrypt(
  ciphertext: string,
  iv: string,
  salt: string,
  authTag: string,
  contextId: string,
  masterKey: Buffer
): string {
  const key = deriveKey(masterKey, contextId, Buffer.from(salt, 'base64'));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  let plaintext = decipher.update(ciphertext, 'base64', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
}

function encrypt(plaintext: string, contextId: string, masterKey: Buffer) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(masterKey, contextId, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
  ciphertext += cipher.final('base64');
  return {
    ciphertext,
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function hashWithKey(email: string, masterKey: Buffer): string {
  return crypto
    .createHmac('sha256', masterKey)
    .update(email.toLowerCase().trim())
    .digest('hex');
}

async function rotateKeys() {
  const oldKeyStr = process.env.OLD_MASTER_ENCRYPTION_KEY;
  const newKeyStr = process.env.MASTER_ENCRYPTION_KEY;

  if (!oldKeyStr || !newKeyStr) {
    console.error(
      'Both OLD_MASTER_ENCRYPTION_KEY and MASTER_ENCRYPTION_KEY must be set.'
    );
    console.error(
      'Usage: OLD_MASTER_ENCRYPTION_KEY=<old> MASTER_ENCRYPTION_KEY=<new> npx ts-node scripts/rotate-key.ts'
    );
    process.exit(1);
  }

  if (oldKeyStr === newKeyStr) {
    console.error('Old and new keys are identical. Nothing to rotate.');
    process.exit(1);
  }

  const oldKey = parseKey(oldKeyStr);
  const newKey = parseKey(newKeyStr);

  // Verify old key works
  console.log('Verifying old key...');
  const testEncrypted = encrypt('test@example.com', 'test-verify', oldKey);
  const testDecrypted = decrypt(
    testEncrypted.ciphertext,
    testEncrypted.iv,
    testEncrypted.salt,
    testEncrypted.authTag,
    'test-verify',
    oldKey
  );
  if (testDecrypted !== 'test@example.com') {
    console.error('Old key verification failed!');
    process.exit(1);
  }
  console.log('Old key verified.\n');

  // Rotate alias emails
  console.log('=== Rotating Alias Emails ===');
  const encryptedAliases = await prisma.alias.findMany({
    where: { isEncrypted: true },
    select: {
      id: true,
      fullAddress: true,
      destinationEmail: true,
      destinationIv: true,
      destinationSalt: true,
      destinationAuthTag: true,
    },
  });

  console.log(`Found ${encryptedAliases.length} encrypted aliases.\n`);

  let aliasSuccess = 0;
  let aliasError = 0;

  for (const alias of encryptedAliases) {
    try {
      if (
        !alias.destinationIv ||
        !alias.destinationSalt ||
        !alias.destinationAuthTag
      ) {
        console.log(`Skipping ${alias.id}: missing encryption fields`);
        continue;
      }

      // Decrypt with old key
      const plaintext = decrypt(
        alias.destinationEmail,
        alias.destinationIv,
        alias.destinationSalt,
        alias.destinationAuthTag,
        alias.id,
        oldKey
      );

      // Re-encrypt with new key
      const newEncrypted = encrypt(plaintext, alias.id, newKey);
      const newHash = hashWithKey(plaintext, newKey);

      await prisma.alias.update({
        where: { id: alias.id },
        data: {
          destinationEmail: newEncrypted.ciphertext,
          destinationIv: newEncrypted.iv,
          destinationSalt: newEncrypted.salt,
          destinationAuthTag: newEncrypted.authTag,
          destinationHash: newHash,
        },
      });

      aliasSuccess++;
    } catch (error) {
      aliasError++;
      console.error(`Failed to rotate alias ${alias.id}:`, error);
    }
  }

  console.log(`Aliases: ${aliasSuccess} rotated, ${aliasError} failed\n`);

  // Rotate user emails
  console.log('=== Rotating User Emails ===');
  const encryptedUsers = await prisma.user.findMany({
    where: { isEmailEncrypted: true },
    select: {
      id: true,
      email: true,
      emailIv: true,
      emailSalt: true,
      emailAuthTag: true,
    },
  });

  console.log(`Found ${encryptedUsers.length} encrypted users.\n`);

  let userSuccess = 0;
  let userError = 0;

  for (const user of encryptedUsers) {
    try {
      if (!user.emailIv || !user.emailSalt || !user.emailAuthTag) {
        console.log(`Skipping user ${user.id}: missing encryption fields`);
        continue;
      }

      const plaintext = decrypt(
        user.email,
        user.emailIv,
        user.emailSalt,
        user.emailAuthTag,
        user.id,
        oldKey
      );
      const newEncrypted = encrypt(plaintext, user.id, newKey);
      const newHash = hashWithKey(plaintext, newKey);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          email: newEncrypted.ciphertext,
          emailHash: newHash,
          emailIv: newEncrypted.iv,
          emailSalt: newEncrypted.salt,
          emailAuthTag: newEncrypted.authTag,
        },
      });

      userSuccess++;
    } catch (error) {
      userError++;
      console.error(`Failed to rotate user ${user.id}:`, error);
    }
  }

  console.log(`Users: ${userSuccess} rotated, ${userError} failed\n`);

  // Summary
  console.log('=== Rotation Summary ===');
  console.log(`Aliases: ${aliasSuccess}/${encryptedAliases.length} rotated`);
  console.log(`Users:   ${userSuccess}/${encryptedUsers.length} rotated`);

  if (aliasError > 0 || userError > 0) {
    console.error(
      '\nWARNING: Some records failed to rotate. Check errors above.'
    );
    console.error(
      'DO NOT update your .env yet — failed records still use the old key.'
    );
    process.exit(1);
  }

  console.log('\nKey rotation completed successfully!');
  console.log(
    'Update your .env to use the new MASTER_ENCRYPTION_KEY and restart the service.'
  );
}

rotateKeys()
  .catch((error) => {
    console.error('Key rotation failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
