/**
 * Encryption Key Rotation Script
 *
 * Re-encrypts all alias destination emails and user emails with a new master
 * key and recomputes all HMAC lookup hashes (aliases.destinationHash,
 * users.emailHash) with the new key -- including legacy rows that were never
 * encrypted (their plaintext is hashed with the new key).
 *
 * Usage:
 *   OLD_MASTER_ENCRYPTION_KEY=<old-key> MASTER_ENCRYPTION_KEY=<new-key> \
 *     npx ts-node scripts/rotate-key.ts [--dry-run] [--skip-broken]
 *
 * Flags:
 *   --dry-run      Read-only. Decrypts every row with the old key and checks
 *                  that re-encryption with the new key round-trips. No writes.
 *   --skip-broken  Rows flagged as encrypted but missing iv/salt/authTag are
 *                  normally a hard error. With this flag they are left as-is
 *                  (they are already undecryptable) and their hash is cleared.
 *
 * Behaviour:
 * - The old key is verified by decrypting a REAL row (first encrypted alias
 *   and first encrypted user). Aborts if that fails.
 * - Aliases, users and verification tokens are rotated in ONE interactive
 *   transaction (timeout 10 min, maxWait 60 s). The aliases/users/
 *   verification_tokens tables are locked against concurrent writes for the
 *   duration. Any error rolls back everything.
 * - verification_tokens.email stores an HMAC of the address under the master
 *   key. Those hashes become meaningless after rotation, so all UNUSED
 *   verification tokens are deleted. Users with a pending verification /
 *   password-reset link must request a new one. Used tokens are kept for
 *   history (their hash is no longer linkable to anything).
 *
 * IMPORTANT:
 * - Back up your database BEFORE running this script (scripts/backup.sh)
 * - Stop the app (or run in a maintenance window); after success, update
 *   MASTER_ENCRYPTION_KEY in .env and restart the app.
 * - Flush the Redis alias cache after rotation if it caches decrypted or
 *   hashed values derived from the old key.
 */

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// --- Crypto: must match src/utils/encryption.ts exactly ---------------------

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

function parseKey(keyStr: string, name: string): Buffer {
  if (keyStr.length === 64) return Buffer.from(keyStr, 'hex');
  if (keyStr.length === 44) return Buffer.from(keyStr, 'base64');
  throw new Error(`${name} must be 32 bytes (64 hex chars or 44 base64 chars)`);
}

function deriveKey(masterKey: Buffer, contextId: string, salt: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', masterKey, salt, `makeanon-alias-${contextId}`, KEY_LENGTH)
  );
}

interface Encrypted {
  ciphertext: string;
  iv: string;
  salt: string;
  authTag: string;
}

function decrypt(data: Encrypted, contextId: string, masterKey: Buffer): string {
  const key = deriveKey(masterKey, contextId, Buffer.from(data.salt, 'base64'));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(data.authTag, 'base64'));
  let plaintext = decipher.update(data.ciphertext, 'base64', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
}

function encrypt(plaintext: string, contextId: string, masterKey: Buffer): Encrypted {
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
  return crypto.createHmac('sha256', masterKey).update(email.toLowerCase().trim()).digest('hex');
}

function tryDecrypt(data: Encrypted, contextId: string, masterKey: Buffer): string | null {
  try {
    return decrypt(data, contextId, masterKey);
  } catch {
    return null;
  }
}

// --- Row shapes -------------------------------------------------------------

interface AliasRow {
  id: string;
  isEncrypted: boolean;
  destinationEmail: string;
  destinationIv: string | null;
  destinationSalt: string | null;
  destinationAuthTag: string | null;
}

interface UserRow {
  id: string;
  isEmailEncrypted: boolean;
  email: string;
  emailIv: string | null;
  emailSalt: string | null;
  emailAuthTag: string | null;
}

const aliasSelect = {
  id: true,
  isEncrypted: true,
  destinationEmail: true,
  destinationIv: true,
  destinationSalt: true,
  destinationAuthTag: true,
} as const;

const userSelect = {
  id: true,
  isEmailEncrypted: true,
  email: true,
  emailIv: true,
  emailSalt: true,
  emailAuthTag: true,
} as const;

function aliasEnc(a: AliasRow): Encrypted | null {
  if (!a.destinationIv || !a.destinationSalt || !a.destinationAuthTag) return null;
  return {
    ciphertext: a.destinationEmail,
    iv: a.destinationIv,
    salt: a.destinationSalt,
    authTag: a.destinationAuthTag,
  };
}

function userEnc(u: UserRow): Encrypted | null {
  if (!u.emailIv || !u.emailSalt || !u.emailAuthTag) return null;
  return { ciphertext: u.email, iv: u.emailIv, salt: u.emailSalt, authTag: u.emailAuthTag };
}

/** Re-encrypt with the new key and confirm it round-trips before writing. */
function reencrypt(plaintext: string, id: string, newKey: Buffer): Encrypted {
  const enc = encrypt(plaintext, id, newKey);
  if (decrypt(enc, id, newKey) !== plaintext) {
    throw new Error(`Round-trip check failed for row ${id}`);
  }
  return enc;
}

// --- Main -------------------------------------------------------------------

const TX_OPTIONS = { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 };

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const skipBroken = args.has('--skip-broken');
  for (const a of args) {
    if (a !== '--dry-run' && a !== '--skip-broken') {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  const oldKeyStr = process.env.OLD_MASTER_ENCRYPTION_KEY;
  const newKeyStr = process.env.MASTER_ENCRYPTION_KEY;
  if (!oldKeyStr || !newKeyStr) {
    throw new Error(
      'Both OLD_MASTER_ENCRYPTION_KEY and MASTER_ENCRYPTION_KEY must be set.\n' +
        'Usage: OLD_MASTER_ENCRYPTION_KEY=<old> MASTER_ENCRYPTION_KEY=<new> ' +
        'npx ts-node scripts/rotate-key.ts [--dry-run] [--skip-broken]'
    );
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set.');
  }

  const oldKey = parseKey(oldKeyStr, 'OLD_MASTER_ENCRYPTION_KEY');
  const newKey = parseKey(newKeyStr, 'MASTER_ENCRYPTION_KEY');
  if (oldKey.equals(newKey)) {
    throw new Error('Old and new keys are identical. Nothing to rotate.');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }) });

  try {
    if (dryRun) console.log('*** DRY RUN: no changes will be written ***\n');

    // --- (a) Verify the old key against real data ---------------------------
    console.log('Verifying old key against real database rows...');
    const sampleAlias = await prisma.alias.findFirst({
      where: { isEncrypted: true, destinationIv: { not: null } },
      select: aliasSelect,
      orderBy: { createdAt: 'asc' },
    });
    const sampleUser = await prisma.user.findFirst({
      where: { isEmailEncrypted: true, emailIv: { not: null } },
      select: userSelect,
      orderBy: { createdAt: 'asc' },
    });

    const checkSample = (kind: string, id: string, enc: Encrypted | null): void => {
      if (!enc) throw new Error(`Sample ${kind} ${id} is missing encryption fields`);
      if (tryDecrypt(enc, id, oldKey) !== null) {
        console.log(`  OK: old key decrypts ${kind} ${id}`);
        return;
      }
      if (tryDecrypt(enc, id, newKey) !== null) {
        throw new Error(
          `Sample ${kind} ${id} decrypts with the NEW key, not the old one. ` +
            'Rotation appears to have already been applied. Aborting.'
        );
      }
      throw new Error(
        `OLD_MASTER_ENCRYPTION_KEY cannot decrypt ${kind} ${id}. Wrong key? Aborting.`
      );
    };

    if (sampleAlias) checkSample('alias', sampleAlias.id, aliasEnc(sampleAlias));
    else console.log('  (no encrypted aliases to verify against)');
    if (sampleUser) checkSample('user', sampleUser.id, userEnc(sampleUser));
    else console.log('  (no encrypted users to verify against)');
    console.log('Old key verified.\n');

    // --- (b) Single transaction for everything ------------------------------
    const summary = await prisma.$transaction(async (tx) => {
      if (!dryRun) {
        // Block concurrent writes (reads still allowed) so no row is written
        // with the old key while we rotate.
        await tx.$executeRawUnsafe(
          'LOCK TABLE "aliases", "users", "verification_tokens" IN SHARE ROW EXCLUSIVE MODE'
        );
      }

      const s = {
        aliasesReencrypted: 0,
        aliasesLegacyRehashed: 0,
        aliasesBrokenSkipped: 0,
        usersReencrypted: 0,
        usersLegacyRehashed: 0,
        usersBrokenSkipped: 0,
        verificationTokensDeleted: 0,
      };

      // Aliases
      const aliases: AliasRow[] = await tx.alias.findMany({ select: aliasSelect });
      console.log(`Processing ${aliases.length} aliases...`);
      for (const alias of aliases) {
        if (!alias.isEncrypted) {
          // (c) Legacy plaintext row: only the hash depends on the key.
          s.aliasesLegacyRehashed++;
          if (!dryRun) {
            await tx.alias.update({
              where: { id: alias.id },
              data: { destinationHash: hashWithKey(alias.destinationEmail, newKey) },
            });
          }
          continue;
        }

        const enc = aliasEnc(alias);
        if (!enc) {
          if (!skipBroken) {
            throw new Error(
              `Alias ${alias.id} is flagged encrypted but missing iv/salt/authTag. ` +
                'Re-run with --skip-broken to leave such rows untouched.'
            );
          }
          console.warn(`  Skipping broken alias ${alias.id} (clearing destinationHash)`);
          s.aliasesBrokenSkipped++;
          if (!dryRun) {
            await tx.alias.update({ where: { id: alias.id }, data: { destinationHash: null } });
          }
          continue;
        }

        // Throws (and rolls back everything) if the old key can't decrypt it.
        const plaintext = decrypt(enc, alias.id, oldKey);
        const next = reencrypt(plaintext, alias.id, newKey);
        s.aliasesReencrypted++;
        if (!dryRun) {
          await tx.alias.update({
            where: { id: alias.id },
            data: {
              destinationEmail: next.ciphertext,
              destinationIv: next.iv,
              destinationSalt: next.salt,
              destinationAuthTag: next.authTag,
              destinationHash: hashWithKey(plaintext, newKey),
            },
          });
        }
      }

      // Users
      const users: UserRow[] = await tx.user.findMany({ select: userSelect });
      console.log(`Processing ${users.length} users...`);
      for (const user of users) {
        if (!user.isEmailEncrypted) {
          s.usersLegacyRehashed++;
          if (!dryRun) {
            await tx.user.update({
              where: { id: user.id },
              data: { emailHash: hashWithKey(user.email, newKey) },
            });
          }
          continue;
        }

        const enc = userEnc(user);
        if (!enc) {
          if (!skipBroken) {
            throw new Error(
              `User ${user.id} is flagged encrypted but missing iv/salt/authTag. ` +
                'Re-run with --skip-broken to leave such rows untouched.'
            );
          }
          console.warn(`  Skipping broken user ${user.id} (clearing emailHash)`);
          s.usersBrokenSkipped++;
          if (!dryRun) {
            await tx.user.update({ where: { id: user.id }, data: { emailHash: null } });
          }
          continue;
        }

        const plaintext = decrypt(enc, user.id, oldKey);
        const next = reencrypt(plaintext, user.id, newKey);
        s.usersReencrypted++;
        if (!dryRun) {
          await tx.user.update({
            where: { id: user.id },
            data: {
              email: next.ciphertext,
              emailIv: next.iv,
              emailSalt: next.salt,
              emailAuthTag: next.authTag,
              emailHash: hashWithKey(plaintext, newKey),
            },
          });
        }
      }

      // (d) Verification tokens: their `email` column is an HMAC under the
      // old key and cannot be recomputed (no plaintext). Delete unused ones.
      if (dryRun) {
        s.verificationTokensDeleted = await tx.verificationToken.count({
          where: { usedAt: null },
        });
      } else {
        const del = await tx.verificationToken.deleteMany({ where: { usedAt: null } });
        s.verificationTokensDeleted = del.count;
      }

      return s;
    }, TX_OPTIONS);

    console.log('\n=== Rotation Summary' + (dryRun ? ' (DRY RUN - nothing written)' : '') + ' ===');
    console.log(`Aliases re-encrypted:            ${summary.aliasesReencrypted}`);
    console.log(`Aliases legacy (hash only):      ${summary.aliasesLegacyRehashed}`);
    console.log(`Aliases broken (skipped):        ${summary.aliasesBrokenSkipped}`);
    console.log(`Users re-encrypted:              ${summary.usersReencrypted}`);
    console.log(`Users legacy (hash only):        ${summary.usersLegacyRehashed}`);
    console.log(`Users broken (skipped):          ${summary.usersBrokenSkipped}`);
    console.log(
      `Unused verification tokens ${dryRun ? 'to delete' : 'deleted'}: ${summary.verificationTokensDeleted}`
    );

    if (dryRun) {
      console.log('\nDry run OK: every encrypted row decrypts with the old key.');
    } else {
      console.log('\nKey rotation committed successfully.');
      console.log('Now: set MASTER_ENCRYPTION_KEY to the new key in .env, restart the app,');
      console.log('and flush any Redis alias cache. Keep the old key until verified.');
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Key rotation failed (all changes rolled back):', error instanceof Error ? error.message : error);
  process.exit(1);
});
