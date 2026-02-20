/**
 * Migration script to encrypt existing plaintext user emails
 *
 * Usage:
 *   npx ts-node scripts/migrate-encrypt-user-emails.ts
 *
 * IMPORTANT: Ensure MASTER_ENCRYPTION_KEY is set in your environment before running!
 */

import { PrismaClient } from '@prisma/client';
import { encryptEmail, hashEmail, verifyEncryptionSetup } from '../src/utils/encryption';

const prisma = new PrismaClient();

async function migrateUserEmails() {
  console.log('Starting user email encryption migration...\n');

  if (!verifyEncryptionSetup()) {
    console.error('ERROR: Encryption setup verification failed!');
    console.error('Make sure MASTER_ENCRYPTION_KEY is set in your environment.');
    process.exit(1);
  }

  console.log('Encryption setup verified\n');

  const unencryptedUsers = await prisma.user.findMany({
    where: { isEmailEncrypted: false },
    select: {
      id: true,
      email: true,
    },
  });

  console.log(`Found ${unencryptedUsers.length} unencrypted user emails to migrate.\n`);

  if (unencryptedUsers.length === 0) {
    console.log('No users to migrate. Exiting.');
    return;
  }

  let successCount = 0;
  let errorCount = 0;

  for (const user of unencryptedUsers) {
    try {
      const plaintextEmail = user.email;
      const encrypted = encryptEmail(plaintextEmail, user.id);
      const emailHashValue = hashEmail(plaintextEmail);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          email: encrypted.ciphertext,
          emailHash: emailHashValue,
          emailIv: encrypted.iv,
          emailSalt: encrypted.salt,
          emailAuthTag: encrypted.authTag,
          isEmailEncrypted: true,
        },
      });

      successCount++;
      console.log(`Migrated user: ${user.id}`);
    } catch (error) {
      errorCount++;
      console.error(`Failed to migrate user ${user.id}:`, error);
    }
  }

  console.log('\n--- Migration Summary ---');
  console.log(`Total users:           ${unencryptedUsers.length}`);
  console.log(`Successfully migrated: ${successCount}`);
  console.log(`Failed:                ${errorCount}`);

  if (errorCount > 0) {
    console.log('\nWARNING: Some users failed to migrate. Check errors above.');
    process.exit(1);
  }

  console.log('\nMigration completed successfully!');
}

migrateUserEmails()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
