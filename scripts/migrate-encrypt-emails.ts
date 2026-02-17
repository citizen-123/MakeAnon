/**
 * Migration script to encrypt existing plaintext destination emails
 *
 * This script:
 * 1. Finds all aliases with isEncrypted = false
 * 2. Encrypts the destinationEmail field
 * 3. Generates a destinationHash for lookups
 * 4. Updates the alias with encrypted data
 *
 * Usage:
 *   npx ts-node scripts/migrate-encrypt-emails.ts
 *
 * IMPORTANT: Ensure MASTER_ENCRYPTION_KEY is set in your environment before running!
 */

import { PrismaClient } from '@prisma/client';
import { encryptEmail, hashEmail, verifyEncryptionSetup } from '../src/utils/encryption';

const prisma = new PrismaClient();

async function migrateEmails() {
  console.log('Starting email encryption migration...\n');

  // Verify encryption is set up
  if (!verifyEncryptionSetup()) {
    console.error('ERROR: Encryption setup verification failed!');
    console.error('Make sure MASTER_ENCRYPTION_KEY is set in your environment.');
    process.exit(1);
  }

  console.log('✓ Encryption setup verified\n');

  // Find all unencrypted aliases
  const unencryptedAliases = await prisma.alias.findMany({
    where: { isEncrypted: false },
    select: {
      id: true,
      destinationEmail: true,
      fullAddress: true,
    },
  });

  console.log(`Found ${unencryptedAliases.length} unencrypted aliases to migrate.\n`);

  if (unencryptedAliases.length === 0) {
    console.log('No aliases to migrate. Exiting.');
    return;
  }

  let successCount = 0;
  let errorCount = 0;

  for (const alias of unencryptedAliases) {
    try {
      // The destinationEmail is currently plaintext
      const plaintextEmail = alias.destinationEmail;

      // Encrypt the email
      const encrypted = encryptEmail(plaintextEmail, alias.id);

      // Generate hash for lookups
      const emailHash = hashEmail(plaintextEmail);

      // Update the alias
      await prisma.alias.update({
        where: { id: alias.id },
        data: {
          destinationEmail: encrypted.ciphertext,
          destinationIv: encrypted.iv,
          destinationSalt: encrypted.salt,
          destinationAuthTag: encrypted.authTag,
          destinationHash: emailHash,
          isEncrypted: true,
        },
      });

      successCount++;
      console.log(`✓ Migrated: ${alias.fullAddress}`);
    } catch (error) {
      errorCount++;
      console.error(`✗ Failed to migrate ${alias.fullAddress}:`, error);
    }
  }

  console.log('\n--- Migration Summary ---');
  console.log(`Total aliases:     ${unencryptedAliases.length}`);
  console.log(`Successfully migrated: ${successCount}`);
  console.log(`Failed:            ${errorCount}`);

  if (errorCount > 0) {
    console.log('\nWARNING: Some aliases failed to migrate. Please check the errors above.');
    process.exit(1);
  }

  console.log('\n✓ Migration completed successfully!');
}

migrateEmails()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
