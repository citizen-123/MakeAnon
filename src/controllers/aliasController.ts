import { Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../services/database';
import { getDefaultDomain, getDomainById } from '../services/domainService';
import { sendAliasVerificationEmail, sendManagementLinkEmail } from '../services/verificationService';
import { checkRateLimit, invalidateAliasCache } from '../services/redis';
import { AuthenticatedRequest } from '../types';
import {
  generateAlias,
  generateManagementToken,
  generateReplyPrefix,
  createFullAliasEmail,
  createManagementUrl,
  isValidEmail,
  isValidCustomAlias,
  isDisposableEmail,
  calculateExpiresAt,
  parseExpiresInDays,
  parsePagination,
  validateOptionalText,
  MAX_EXPIRES_IN_DAYS,
  MIN_EXPIRES_IN_DAYS,
  MAX_LABEL_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_REASON_LENGTH,
} from '../utils/helpers';
import { encryptEmail, decryptEmail, hashEmail, EncryptedData } from '../utils/encryption';
import logger from '../utils/logger';

const MAX_ALIASES_PER_EMAIL = parseInt(process.env.MAX_ALIASES_PER_EMAIL || '10');
const MAX_ALIASES_PER_USER = parseInt(process.env.MAX_ALIASES_PER_USER || '100');
const ALIAS_CREATION_LIMIT = parseInt(process.env.ALIAS_CREATION_LIMIT_PER_HOUR || '10');
const ALIAS_CREATION_LIMIT_PER_IP = parseInt(process.env.ALIAS_CREATION_LIMIT_PER_IP_PER_HOUR || '20');
const ALLOW_CUSTOM_ALIASES = process.env.ALLOW_CUSTOM_ALIASES !== 'false';
// Verification is required unless explicitly disabled
const REQUIRE_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION !== 'false';
const BLOCK_DISPOSABLE = process.env.BLOCK_DISPOSABLE_EMAILS === 'true';

const MAX_BLOCK_PATTERN_LENGTH = 254;
const MAX_BLOCK_PATTERN_WILDCARDS = 5;

const ALIAS_SORT_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'alias',
  'fullAddress',
  'label',
  'forwardCount',
  'lastForwardAt',
  'expiresAt',
  'isActive',
]);

type Body = Record<string, unknown>;

function getBody(req: Request): Body {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Body) : {};
}

/**
 * Validate label/description inputs. Returns an error message or null.
 */
function validateLabelAndDescription(label: unknown, description: unknown): string | null {
  return (
    validateOptionalText(label, 'label', MAX_LABEL_LENGTH) ||
    validateOptionalText(description, 'description', MAX_DESCRIPTION_LENGTH)
  );
}

const EXPIRES_IN_ERROR = `expiresIn must be an integer number of days between ${MIN_EXPIRES_IN_DAYS} and ${MAX_EXPIRES_IN_DAYS}, or null`;

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/**
 * Compute disabledAt transitions when isActive changes:
 * - deactivating sets disabledAt (drives 30-day auto-deletion)
 * - activating clears it
 */
function disabledAtTransition(wasActive: boolean, isActive: boolean | undefined): Date | null | undefined {
  if (isActive === undefined) return undefined;
  if (isActive === false && wasActive) return new Date();
  if (isActive === true && !wasActive) return null;
  return undefined;
}

/**
 * Strip encryption fields and decrypt destination email for API response
 */
function decryptAliasForResponse(alias: any): any {
  let destinationEmail = alias.destinationEmail;
  if (alias.isEncrypted && alias.destinationIv && alias.destinationSalt && alias.destinationAuthTag) {
    const encryptedData: EncryptedData = {
      ciphertext: alias.destinationEmail,
      iv: alias.destinationIv,
      salt: alias.destinationSalt,
      authTag: alias.destinationAuthTag,
    };
    destinationEmail = decryptEmail(encryptedData, alias.id);
  }

  const { destinationIv, destinationSalt, destinationAuthTag, isEncrypted, destinationHash, ...safeAlias } = alias;
  return { ...safeAlias, destinationEmail };
}

// ============================================================================
// Public Alias Creation (No Auth Required)
// ============================================================================

/**
 * Create a public alias - no authentication required
 * Only requires destination email and optionally a custom alias
 */
export async function createPublicAlias(req: Request, res: Response): Promise<void> {
  try {
    const { destinationEmail, domainId, customAlias, label, description, expiresIn } = getBody(req);

    // Per-IP creation limit (checked first so varying the destination doesn't help)
    const ipLimit = await checkRateLimit(`alias:create:ip:${req.ip || 'unknown'}`, ALIAS_CREATION_LIMIT_PER_IP, 3600);
    if (!ipLimit.allowed) {
      res.status(429).json({
        success: false,
        error: 'Too many aliases created. Please try again later.',
        retryAfter: Math.ceil((ipLimit.resetAt.getTime() - Date.now()) / 1000),
      });
      return;
    }

    // Validate destination email
    if (!isValidEmail(destinationEmail)) {
      res.status(400).json({
        success: false,
        error: 'Please provide a valid destination email address',
      });
      return;
    }

    if (domainId !== undefined && domainId !== null && typeof domainId !== 'string') {
      res.status(400).json({ success: false, error: 'Invalid domain selected' });
      return;
    }

    if (customAlias !== undefined && customAlias !== null && typeof customAlias !== 'string') {
      res.status(400).json({ success: false, error: 'Invalid alias format' });
      return;
    }

    const textError = validateLabelAndDescription(label, description);
    if (textError) {
      res.status(400).json({ success: false, error: textError });
      return;
    }

    const expiry = parseExpiresInDays(expiresIn);
    if (!expiry.valid) {
      res.status(400).json({ success: false, error: EXPIRES_IN_ERROR });
      return;
    }

    const email = destinationEmail.toLowerCase();

    // Block disposable emails if configured
    if (BLOCK_DISPOSABLE && isDisposableEmail(email)) {
      res.status(400).json({
        success: false,
        error: 'Disposable email addresses are not allowed',
      });
      return;
    }

    const emailHash = hashEmail(email);

    // Rate limiting per destination email (keyed by hash - no plaintext in Redis)
    const rateLimit = await checkRateLimit(`alias:create:${emailHash}`, ALIAS_CREATION_LIMIT, 3600);
    if (!rateLimit.allowed) {
      res.status(429).json({
        success: false,
        error: `Too many aliases created. Please try again later.`,
        retryAfter: Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000),
      });
      return;
    }

    // Check alias limit per email (using hash for privacy). Counts aliases that are
    // active or still pending verification; disabled aliases don't count.
    const existingCount = await prisma.alias.count({
      where: {
        destinationHash: emailHash,
        isPrivate: false,
        OR: [{ isActive: true }, { emailVerified: false }],
      },
    });

    if (existingCount >= MAX_ALIASES_PER_EMAIL) {
      res.status(400).json({
        success: false,
        error: 'Unable to create an alias for this address right now. Please try again later or create an account.',
      });
      return;
    }

    // Get domain (public aliases may only use active, public domains)
    const domain = domainId
      ? await getDomainById(domainId as string, { activeOnly: true, publicOnly: true })
      : await getDefaultDomain();
    if (!domain) {
      res.status(400).json({
        success: false,
        error: 'Invalid domain selected',
      });
      return;
    }

    // Handle custom or generated alias
    let aliasName: string;

    if (customAlias) {
      if (!ALLOW_CUSTOM_ALIASES) {
        res.status(400).json({
          success: false,
          error: 'Custom aliases are not allowed',
        });
        return;
      }

      if (!isValidCustomAlias(customAlias)) {
        res.status(400).json({
          success: false,
          error: 'Invalid or reserved alias. Use 4-32 alphanumeric characters, dots, hyphens, or underscores.',
        });
        return;
      }

      // Check if custom alias is available
      const existing = await prisma.alias.findFirst({
        where: {
          alias: customAlias.toLowerCase(),
          domainId: domain.id,
        },
      });

      if (existing) {
        res.status(409).json({
          success: false,
          error: 'This alias is already taken. Please choose a different one.',
        });
        return;
      }

      aliasName = customAlias.toLowerCase();
    } else {
      // Generate unique alias
      let attempts = 0;
      const maxAttempts = 10;

      do {
        aliasName = generateAlias();
        const existing = await prisma.alias.findFirst({
          where: { alias: aliasName, domainId: domain.id },
        });
        if (!existing) break;
        attempts++;
      } while (attempts < maxAttempts);

      if (attempts >= maxAttempts) {
        res.status(500).json({
          success: false,
          error: 'Failed to generate unique alias. Please try again.',
        });
        return;
      }
    }

    const fullAddress = createFullAliasEmail(aliasName, domain.domain);
    const managementToken = generateManagementToken();
    const replyPrefix = generateReplyPrefix();

    // Generate a temporary ID for encryption (we'll use the actual ID after creation)
    const tempId = crypto.randomUUID();

    // Encrypt the destination email
    const encryptedData = encryptEmail(email, tempId);

    // When verification is required the alias stays inactive (and does not
    // forward) until the destination owner clicks the verification link.
    const newAlias = await prisma.alias.create({
      data: {
        id: tempId, // Use the same ID we used for encryption
        alias: aliasName,
        domainId: domain.id,
        fullAddress,
        destinationEmail: encryptedData.ciphertext,
        destinationIv: encryptedData.iv,
        destinationSalt: encryptedData.salt,
        destinationAuthTag: encryptedData.authTag,
        destinationHash: emailHash,
        isEncrypted: true,
        emailVerified: !REQUIRE_VERIFICATION,
        label: (label as string | null | undefined) || null,
        description: (description as string | null | undefined) || null,
        isActive: !REQUIRE_VERIFICATION,
        isPrivate: false,
        managementToken,
        replyPrefix,
        replyEnabled: false,
        expiresAt: expiry.days ? calculateExpiresAt(expiry.days) : null,
      },
      include: {
        domain: {
          select: { id: true, domain: true },
        },
      },
    });

    // Update domain alias count
    await prisma.domain.update({
      where: { id: domain.id },
      data: { aliasCount: { increment: 1 } },
    });

    // Drop any stale cache entry for this address
    await invalidateAliasCache(fullAddress);

    // Send verification email
    if (REQUIRE_VERIFICATION) {
      await sendAliasVerificationEmail(email, fullAddress, newAlias.id);
    } else {
      // Send management link directly
      await sendManagementLinkEmail(email, fullAddress, createManagementUrl(managementToken));
    }

    logger.info(`Public alias created: ${fullAddress} -> [encrypted]`);

    res.status(201).json({
      success: true,
      data: {
        id: newAlias.id,
        alias: newAlias.alias,
        fullAddress: newAlias.fullAddress,
        domain: newAlias.domain,
        destinationEmail: email, // Return plaintext to the creator (they know their own email)
        emailVerified: newAlias.emailVerified,
        isActive: newAlias.isActive,
        label: newAlias.label,
        replyEnabled: newAlias.replyEnabled,
        createdAt: newAlias.createdAt,
        expiresAt: newAlias.expiresAt,
        managementToken: managementToken,
      },
      message: REQUIRE_VERIFICATION
        ? 'Alias created! Check your inbox and verify your email within 72 hours to activate it.'
        : 'Alias created!',
    });
  } catch (error) {
    logger.error('Create public alias error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create alias',
    });
  }
}

// ============================================================================
// Alias Management via Token (No Auth Required)
// ============================================================================

/**
 * Get alias by management token
 */
export async function getAliasByToken(req: Request, res: Response): Promise<void> {
  try {
    const token = req.params.token as string;

    const alias = await prisma.alias.findUnique({
      where: { managementToken: token },
      include: {
        domain: { select: { id: true, domain: true } },
        emailLogs: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            fromEmail: true,
            subject: true,
            status: true,
            createdAt: true,
          },
        },
        blockedSenders: {
          select: { id: true, email: true, reason: true },
        },
      },
    });

    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found or invalid management token',
      });
      return;
    }

    const safeAlias = decryptAliasForResponse(alias);

    // Calculate scheduled deletion info
    let scheduledDeletion: { date: string; reason: string } | null = null;

    if (!alias.emailVerified) {
      // Unverified aliases are deleted 72 hours after creation
      const deletionDate = new Date(alias.createdAt);
      deletionDate.setHours(deletionDate.getHours() + 72);
      scheduledDeletion = {
        date: deletionDate.toISOString(),
        reason: 'Unverified alias (72 hours after creation)',
      };
    } else if (!alias.isActive && alias.disabledAt) {
      // Disabled aliases are deleted 30 days after being disabled
      const deletionDate = new Date(alias.disabledAt);
      deletionDate.setDate(deletionDate.getDate() + 30);
      scheduledDeletion = {
        date: deletionDate.toISOString(),
        reason: 'Disabled alias (30 days after disabling)',
      };
    }

    res.json({
      success: true,
      data: {
        ...safeAlias,
        scheduledDeletion,
      },
    });
  } catch (error) {
    logger.error('Get alias by token error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get alias',
    });
  }
}

/**
 * Update alias via management token
 */
export async function updateAliasByToken(req: Request, res: Response): Promise<void> {
  try {
    const token = req.params.token as string;
    const { label, description, isActive, replyEnabled } = getBody(req);

    const textError = validateLabelAndDescription(label, description);
    if (textError) {
      res.status(400).json({ success: false, error: textError });
      return;
    }
    if (!isOptionalBoolean(isActive) || !isOptionalBoolean(replyEnabled)) {
      res.status(400).json({ success: false, error: 'isActive and replyEnabled must be booleans' });
      return;
    }

    const alias = await prisma.alias.findUnique({
      where: { managementToken: token },
    });

    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found or invalid management token',
      });
      return;
    }

    if (isActive === true && !alias.emailVerified) {
      res.status(403).json({
        success: false,
        error: 'Please verify the destination email address before activating this alias',
      });
      return;
    }

    // Track disabledAt for auto-deletion scheduling
    const disabledAt = disabledAtTransition(alias.isActive, isActive as boolean | undefined);

    const updated = await prisma.alias.update({
      where: { id: alias.id },
      data: {
        ...(label !== undefined && { label: (label as string | null) || null }),
        ...(description !== undefined && { description: (description as string | null) || null }),
        ...(isActive !== undefined && { isActive: isActive as boolean }),
        ...(replyEnabled !== undefined && { replyEnabled: replyEnabled as boolean }),
        ...(disabledAt !== undefined && { disabledAt }),
      },
      include: {
        domain: { select: { id: true, domain: true } },
      },
    });

    await invalidateAliasCache(alias.fullAddress);

    logger.info(`Alias updated via token: ${updated.fullAddress}`);

    res.json({
      success: true,
      data: decryptAliasForResponse(updated),
      message: 'Alias updated successfully',
    });
  } catch (error) {
    logger.error('Update alias by token error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update alias',
    });
  }
}

/**
 * Delete alias via management token
 */
export async function deleteAliasByToken(req: Request, res: Response): Promise<void> {
  try {
    const token = req.params.token as string;

    const alias = await prisma.alias.findUnique({
      where: { managementToken: token },
    });

    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found or invalid management token',
      });
      return;
    }

    await prisma.alias.delete({ where: { id: alias.id } });

    // Update domain count
    await prisma.domain.update({
      where: { id: alias.domainId },
      data: { aliasCount: { decrement: 1 } },
    });

    await invalidateAliasCache(alias.fullAddress);

    logger.info(`Alias deleted via token: ${alias.fullAddress}`);

    res.json({
      success: true,
      message: 'Alias deleted successfully',
    });
  } catch (error) {
    logger.error('Delete alias by token error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete alias',
    });
  }
}

/**
 * Validate a glob-style email pattern (e.g., *@spam.com, spammer@*).
 * Expects consecutive '*' to already be collapsed.
 */
export function isValidEmailPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_BLOCK_PATTERN_LENGTH) return false;
  if (!pattern.includes('@')) return false;
  if (!pattern.includes('*') && !pattern.includes('?')) return false;
  if ((pattern.match(/\*/g) || []).length > MAX_BLOCK_PATTERN_WILDCARDS) return false;
  return /^[a-zA-Z0-9._%+\-*?@]+$/.test(pattern);
}

/**
 * Normalize a block pattern: lowercase and collapse runs of '*' into one
 */
export function normalizeBlockPattern(pattern: string): string {
  return pattern.toLowerCase().replace(/\*+/g, '*');
}

/**
 * Block a sender for an alias
 */
export async function blockSender(req: Request, res: Response): Promise<void> {
  try {
    const token = req.params.token as string;
    const { email: rawEmail, reason, isPattern } = getBody(req);

    if (!rawEmail || typeof rawEmail !== 'string' || rawEmail.length > MAX_BLOCK_PATTERN_LENGTH) {
      res.status(400).json({
        success: false,
        error: 'Please provide an email address or pattern to block',
      });
      return;
    }

    const reasonError = validateOptionalText(reason, 'reason', MAX_REASON_LENGTH);
    if (reasonError) {
      res.status(400).json({ success: false, error: reasonError });
      return;
    }

    const email = isPattern ? normalizeBlockPattern(rawEmail) : rawEmail.toLowerCase();

    if (isPattern) {
      if (!isValidEmailPattern(email)) {
        res.status(400).json({
          success: false,
          error: `Invalid pattern. Use up to ${MAX_BLOCK_PATTERN_WILDCARDS} * or ? wildcards with a valid email format (e.g., *@spam.com)`,
        });
        return;
      }
    } else if (!isValidEmail(email)) {
      res.status(400).json({
        success: false,
        error: 'Please provide a valid email address to block',
      });
      return;
    }

    const alias = await prisma.alias.findUnique({
      where: { managementToken: token },
    });

    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found or invalid management token',
      });
      return;
    }

    const blocked = await prisma.blockedSender.upsert({
      where: {
        aliasId_email: {
          aliasId: alias.id,
          email,
        },
      },
      create: {
        aliasId: alias.id,
        email,
        isPattern: !!isPattern,
        reason: (reason as string | null | undefined) || null,
      },
      update: {
        isPattern: !!isPattern,
        reason: (reason as string | null | undefined) || null,
      },
    });

    // Blocked senders are part of the cached alias record used by the mail path
    await invalidateAliasCache(alias.fullAddress);

    logger.info(`Sender blocked for ${alias.fullAddress}`);

    res.json({
      success: true,
      data: blocked,
      message: 'Sender blocked successfully',
    });
  } catch (error) {
    logger.error('Block sender error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to block sender',
    });
  }
}

/**
 * Unblock a sender
 */
export async function unblockSender(req: Request, res: Response): Promise<void> {
  try {
    const token = req.params.token as string;
    const senderId = req.params.senderId as string;

    const alias = await prisma.alias.findUnique({
      where: { managementToken: token },
    });

    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found or invalid management token',
      });
      return;
    }

    await prisma.blockedSender.deleteMany({
      where: { id: senderId, aliasId: alias.id },
    });

    await invalidateAliasCache(alias.fullAddress);

    res.json({
      success: true,
      message: 'Sender unblocked successfully',
    });
  } catch (error) {
    logger.error('Unblock sender error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to unblock sender',
    });
  }
}

// ============================================================================
// Authenticated Alias Management (For Private Aliases)
// ============================================================================

/**
 * Create a private alias (requires authentication)
 */
export async function createPrivateAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { destinationEmail, domainId, customAlias, label, description, expiresIn } = getBody(req);

    if (destinationEmail !== undefined && destinationEmail !== null && destinationEmail !== '') {
      if (!isValidEmail(destinationEmail)) {
        res.status(400).json({
          success: false,
          error: 'Please provide a valid destination email address',
        });
        return;
      }
      if (BLOCK_DISPOSABLE && isDisposableEmail(destinationEmail)) {
        res.status(400).json({
          success: false,
          error: 'Disposable email addresses are not allowed',
        });
        return;
      }
    }

    if (domainId !== undefined && domainId !== null && typeof domainId !== 'string') {
      res.status(400).json({ success: false, error: 'Invalid domain selected' });
      return;
    }

    if (customAlias !== undefined && customAlias !== null && typeof customAlias !== 'string') {
      res.status(400).json({ success: false, error: 'Invalid alias format' });
      return;
    }

    const textError = validateLabelAndDescription(label, description);
    if (textError) {
      res.status(400).json({ success: false, error: textError });
      return;
    }

    const expiry = parseExpiresInDays(expiresIn);
    if (!expiry.valid) {
      res.status(400).json({ success: false, error: EXPIRES_IN_ERROR });
      return;
    }

    // Get user with their limits
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        emailHash: true,
        emailIv: true,
        emailSalt: true,
        emailAuthTag: true,
        isEmailEncrypted: true,
        emailVerified: true,
        maxAliases: true,
      },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Use user's email if no destination provided (decrypt if encrypted)
    let fallbackEmail = user.email;
    if (!destinationEmail && user.isEmailEncrypted && user.emailIv && user.emailSalt && user.emailAuthTag) {
      const encryptedData: EncryptedData = {
        ciphertext: user.email,
        iv: user.emailIv,
        salt: user.emailSalt,
        authTag: user.emailAuthTag,
      };
      fallbackEmail = decryptEmail(encryptedData, userId);
    }
    const email = ((destinationEmail as string) || fallbackEmail).toLowerCase();

    // Check alias limit
    const aliasCount = await prisma.alias.count({
      where: { userId },
    });

    if (aliasCount >= (user.maxAliases || MAX_ALIASES_PER_USER)) {
      res.status(400).json({
        success: false,
        error: `Maximum number of aliases (${user.maxAliases || MAX_ALIASES_PER_USER}) reached`,
      });
      return;
    }

    // Get domain (private aliases may use any active domain)
    const domain = domainId
      ? await getDomainById(domainId as string, { activeOnly: true })
      : await getDefaultDomain();
    if (!domain) {
      res.status(400).json({
        success: false,
        error: 'Invalid domain selected',
      });
      return;
    }

    // Handle custom or generated alias
    let aliasName: string;

    if (customAlias) {
      if (!ALLOW_CUSTOM_ALIASES) {
        res.status(400).json({
          success: false,
          error: 'Custom aliases are not allowed',
        });
        return;
      }

      if (!isValidCustomAlias(customAlias)) {
        res.status(400).json({
          success: false,
          error: 'Invalid or reserved alias format',
        });
        return;
      }

      const existing = await prisma.alias.findFirst({
        where: { alias: customAlias.toLowerCase(), domainId: domain.id },
      });

      if (existing) {
        res.status(409).json({
          success: false,
          error: 'This alias is already taken',
        });
        return;
      }

      aliasName = customAlias.toLowerCase();
    } else {
      let attempts = 0;
      do {
        aliasName = generateAlias();
        const existing = await prisma.alias.findFirst({
          where: { alias: aliasName, domainId: domain.id },
        });
        if (!existing) break;
        attempts++;
      } while (attempts < 10);

      if (attempts >= 10) {
        res.status(500).json({
          success: false,
          error: 'Failed to generate unique alias',
        });
        return;
      }
    }

    const fullAddress = createFullAliasEmail(aliasName, domain.domain);
    const replyPrefix = generateReplyPrefix();

    // Generate ID for encryption key derivation
    const aliasId = crypto.randomUUID();

    // Encrypt the destination email
    const encryptedData = encryptEmail(email, aliasId);
    const emailHash = hashEmail(email);

    // Only skip verification when forwarding to the account's own, already
    // verified address. Any other destination must be verified by its owner.
    const ownsDestination = !!user.emailVerified && !!user.emailHash && user.emailHash === emailHash;
    const verified = !REQUIRE_VERIFICATION || ownsDestination;

    const newAlias = await prisma.alias.create({
      data: {
        id: aliasId,
        alias: aliasName,
        domainId: domain.id,
        fullAddress,
        destinationEmail: encryptedData.ciphertext,
        destinationIv: encryptedData.iv,
        destinationSalt: encryptedData.salt,
        destinationAuthTag: encryptedData.authTag,
        destinationHash: emailHash,
        isEncrypted: true,
        emailVerified: verified,
        label: (label as string | null | undefined) || null,
        description: (description as string | null | undefined) || null,
        isActive: verified,
        isPrivate: true,
        userId,
        replyPrefix,
        replyEnabled: false,
        expiresAt: expiry.days ? calculateExpiresAt(expiry.days) : null,
      },
      include: {
        domain: { select: { id: true, domain: true } },
      },
    });

    // Update domain count
    await prisma.domain.update({
      where: { id: domain.id },
      data: { aliasCount: { increment: 1 } },
    });

    await invalidateAliasCache(fullAddress);

    if (!verified) {
      await sendAliasVerificationEmail(email, fullAddress, newAlias.id);
    }

    logger.info(`Private alias created: ${fullAddress} for user ${userId}`);

    const safeAlias = decryptAliasForResponse(newAlias);
    // Override with the known plaintext email (we have it from the request)
    safeAlias.destinationEmail = email;
    res.status(201).json({
      success: true,
      data: safeAlias,
      message: verified
        ? 'Alias created successfully'
        : 'Alias created. Verify the destination email address to activate it.',
    });
  } catch (error) {
    logger.error('Create private alias error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create alias',
    });
  }
}

/**
 * Get user's aliases
 */
export async function getAliases(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { sortBy, sortOrder, active } = req.query;
    const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20, 100);

    const sortField = typeof sortBy === 'string' && ALIAS_SORT_FIELDS.has(sortBy) ? sortBy : 'createdAt';
    const sortDirection: 'asc' | 'desc' = sortOrder === 'asc' ? 'asc' : 'desc';

    const where: { userId: string; isActive?: boolean } = { userId };

    if (typeof active === 'string') {
      where.isActive = active === 'true';
    }

    const [aliases, total] = await Promise.all([
      prisma.alias.findMany({
        where,
        orderBy: { [sortField]: sortDirection },
        skip,
        take: limit,
        include: {
          domain: { select: { id: true, domain: true } },
        },
      }),
      prisma.alias.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        items: aliases.map(decryptAliasForResponse),
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      },
    });
  } catch (error) {
    logger.error('Get aliases error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get aliases',
    });
  }
}

/**
 * Get single alias by ID
 */
export async function getAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const id = req.params.id as string;

    const alias = await prisma.alias.findFirst({
      where: { id, userId },
      include: {
        domain: { select: { id: true, domain: true } },
        emailLogs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        blockedSenders: true,
      },
    });

    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found',
      });
      return;
    }

    res.json({
      success: true,
      data: decryptAliasForResponse(alias),
    });
  } catch (error) {
    logger.error('Get alias error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get alias',
    });
  }
}

/**
 * Update alias
 */
export async function updateAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const id = req.params.id as string;
    const { label, description, isActive, replyEnabled, expiresAt } = getBody(req);

    const textError = validateLabelAndDescription(label, description);
    if (textError) {
      res.status(400).json({ success: false, error: textError });
      return;
    }
    if (!isOptionalBoolean(isActive) || !isOptionalBoolean(replyEnabled)) {
      res.status(400).json({ success: false, error: 'isActive and replyEnabled must be booleans' });
      return;
    }

    // expiresAt: null clears it; otherwise a date in the future within the max window
    let parsedExpiresAt: Date | null | undefined = undefined;
    if (expiresAt === null) {
      parsedExpiresAt = null;
    } else if (expiresAt !== undefined) {
      const date = typeof expiresAt === 'string' ? new Date(expiresAt) : null;
      const maxDate = calculateExpiresAt(MAX_EXPIRES_IN_DAYS + 1);
      if (!date || isNaN(date.getTime()) || date.getTime() <= Date.now() || date > maxDate) {
        res.status(400).json({
          success: false,
          error: `expiresAt must be null or an ISO date within ${MAX_EXPIRES_IN_DAYS} days`,
        });
        return;
      }
      parsedExpiresAt = date;
    }

    const existing = await prisma.alias.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      res.status(404).json({
        success: false,
        error: 'Alias not found',
      });
      return;
    }

    if (isActive === true && !existing.emailVerified) {
      res.status(403).json({
        success: false,
        error: 'Please verify the destination email address before activating this alias',
      });
      return;
    }

    const disabledAt = disabledAtTransition(existing.isActive, isActive as boolean | undefined);

    const updated = await prisma.alias.update({
      where: { id },
      data: {
        ...(label !== undefined && { label: (label as string | null) || null }),
        ...(description !== undefined && { description: (description as string | null) || null }),
        ...(isActive !== undefined && { isActive: isActive as boolean }),
        ...(replyEnabled !== undefined && { replyEnabled: replyEnabled as boolean }),
        ...(parsedExpiresAt !== undefined && { expiresAt: parsedExpiresAt }),
        ...(disabledAt !== undefined && { disabledAt }),
      },
      include: {
        domain: { select: { id: true, domain: true } },
      },
    });

    await invalidateAliasCache(existing.fullAddress);

    logger.info(`Alias updated: ${updated.fullAddress}`);

    res.json({
      success: true,
      data: decryptAliasForResponse(updated),
      message: 'Alias updated successfully',
    });
  } catch (error) {
    logger.error('Update alias error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update alias',
    });
  }
}

/**
 * Delete alias
 */
export async function deleteAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const id = req.params.id as string;

    const existing = await prisma.alias.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      res.status(404).json({
        success: false,
        error: 'Alias not found',
      });
      return;
    }

    await prisma.alias.delete({ where: { id } });

    await prisma.domain.update({
      where: { id: existing.domainId },
      data: { aliasCount: { decrement: 1 } },
    });

    await invalidateAliasCache(existing.fullAddress);

    logger.info(`Alias deleted: ${existing.fullAddress}`);

    res.json({
      success: true,
      message: 'Alias deleted successfully',
    });
  } catch (error) {
    logger.error('Delete alias error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete alias',
    });
  }
}

/**
 * Toggle alias active status
 */
export async function toggleAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const id = req.params.id as string;

    const existing = await prisma.alias.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      res.status(404).json({
        success: false,
        error: 'Alias not found',
      });
      return;
    }

    const nextActive = !existing.isActive;

    if (nextActive && !existing.emailVerified) {
      res.status(403).json({
        success: false,
        error: 'Please verify the destination email address before activating this alias',
      });
      return;
    }

    const updated = await prisma.alias.update({
      where: { id },
      data: {
        isActive: nextActive,
        disabledAt: nextActive ? null : new Date(),
      },
      include: {
        domain: { select: { id: true, domain: true } },
      },
    });

    await invalidateAliasCache(existing.fullAddress);

    res.json({
      success: true,
      data: decryptAliasForResponse(updated),
      message: `Alias ${updated.isActive ? 'activated' : 'deactivated'} successfully`,
    });
  } catch (error) {
    logger.error('Toggle alias error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to toggle alias',
    });
  }
}

/**
 * Get user statistics
 */
export async function getStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { maxAliases: true },
    });

    const [totalAliases, activeAliases, forwardStats, recentActivity] = await Promise.all([
      prisma.alias.count({ where: { userId } }),
      prisma.alias.count({ where: { userId, isActive: true } }),
      prisma.alias.aggregate({
        where: { userId },
        _sum: { forwardCount: true },
      }),
      prisma.alias.findMany({
        where: { userId, lastForwardAt: { not: null } },
        orderBy: { lastForwardAt: 'desc' },
        take: 5,
        select: {
          id: true,
          alias: true,
          fullAddress: true,
          label: true,
          lastForwardAt: true,
          forwardCount: true,
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        totalAliases,
        activeAliases,
        inactiveAliases: totalAliases - activeAliases,
        totalForwarded: forwardStats._sum.forwardCount || 0,
        maxAliases: user?.maxAliases || MAX_ALIASES_PER_USER,
        recentActivity,
      },
    });
  } catch (error) {
    logger.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get statistics',
    });
  }
}

/**
 * Get email logs for user
 */
export async function getEmailLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { aliasId, status } = req.query;
    const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20, 100);

    if ((aliasId !== undefined && typeof aliasId !== 'string') || (status !== undefined && typeof status !== 'string')) {
      res.status(400).json({ success: false, error: 'Invalid filter parameters' });
      return;
    }

    const where: { userId: string; aliasId?: string; status?: string } = { userId };

    if (aliasId) where.aliasId = aliasId as string;
    if (status) where.status = status as string;

    const [logs, total] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          alias: {
            select: { alias: true, fullAddress: true, label: true },
          },
        },
      }),
      prisma.emailLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        items: logs,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logger.error('Get email logs error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get email logs',
    });
  }
}
