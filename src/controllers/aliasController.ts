import { Request, Response } from 'express';
import prisma from '../services/database';
import { getDefaultDomain, getDomainById } from '../services/domainService';
import { sendAliasVerificationEmail, sendManagementLinkEmail } from '../services/verificationService';
import { checkRateLimit, invalidateAliasCache } from '../services/redis';
import { AuthenticatedRequest, CreatePublicAliasInput, UpdateAliasInput } from '../types';
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
} from '../utils/helpers';
import logger from '../utils/logger';

const MAX_ALIASES_PER_EMAIL = parseInt(process.env.MAX_ALIASES_PER_EMAIL || '10');
const MAX_ALIASES_PER_USER = parseInt(process.env.MAX_ALIASES_PER_USER || '100');
const ALIAS_CREATION_LIMIT = parseInt(process.env.ALIAS_CREATION_LIMIT_PER_HOUR || '10');
const ALLOW_CUSTOM_ALIASES = process.env.ALLOW_CUSTOM_ALIASES !== 'false';
const REQUIRE_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === 'true'; // Default to false
const BLOCK_DISPOSABLE = process.env.BLOCK_DISPOSABLE_EMAILS === 'true';

// ============================================================================
// Public Alias Creation (No Auth Required)
// ============================================================================

/**
 * Create a public alias - no authentication required
 * Only requires destination email and optionally a custom alias
 */
export async function createPublicAlias(req: Request, res: Response): Promise<void> {
  try {
    const { destinationEmail, domainId, customAlias, label, description, expiresIn }: CreatePublicAliasInput = req.body;

    // Validate destination email
    if (!destinationEmail || !isValidEmail(destinationEmail)) {
      res.status(400).json({
        success: false,
        error: 'Please provide a valid destination email address',
      });
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

    // Rate limiting per destination email
    const rateLimit = await checkRateLimit(`alias:create:${email}`, ALIAS_CREATION_LIMIT, 3600);
    if (!rateLimit.allowed) {
      res.status(429).json({
        success: false,
        error: `Too many aliases created. Please try again later.`,
        retryAfter: Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000),
      });
      return;
    }

    // Check alias limit per email
    const existingCount = await prisma.alias.count({
      where: { destinationEmail: email, isPrivate: false },
    });

    if (existingCount >= MAX_ALIASES_PER_EMAIL) {
      res.status(400).json({
        success: false,
        error: `Maximum number of aliases (${MAX_ALIASES_PER_EMAIL}) for this email reached. Create an account for more aliases.`,
      });
      return;
    }

    // Get domain
    let domain = domainId ? await getDomainById(domainId) : await getDefaultDomain();
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
          error: 'Invalid alias format. Use 4-32 alphanumeric characters, dots, hyphens, or underscores.',
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

    // Create alias - always active by default, verification is optional
    const newAlias = await prisma.alias.create({
      data: {
        alias: aliasName,
        domainId: domain.id,
        fullAddress,
        destinationEmail: email,
        emailVerified: !REQUIRE_VERIFICATION,
        label: label || null,
        description: description || null,
        isActive: true, // Always active by default
        isPrivate: false,
        managementToken,
        replyPrefix,
        replyEnabled: true,
        expiresAt: expiresIn ? calculateExpiresAt(expiresIn) : null,
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

    // Send verification email
    if (REQUIRE_VERIFICATION) {
      await sendAliasVerificationEmail(email, fullAddress, managementToken);
    } else {
      // Send management link directly
      await sendManagementLinkEmail(email, fullAddress, createManagementUrl(managementToken));
    }

    logger.info(`Public alias created: ${fullAddress} -> ${email}`);

    res.status(201).json({
      success: true,
      data: {
        id: newAlias.id,
        alias: newAlias.alias,
        fullAddress: newAlias.fullAddress,
        domain: newAlias.domain,
        destinationEmail: newAlias.destinationEmail,
        emailVerified: newAlias.emailVerified,
        isActive: newAlias.isActive,
        label: newAlias.label,
        replyEnabled: newAlias.replyEnabled,
        createdAt: newAlias.createdAt,
        expiresAt: newAlias.expiresAt,
        managementToken: managementToken,
      },
      message: 'Alias created! Please verify your email within 72 hours to keep it active.',
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
    const { token } = req.params;

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
        ...alias,
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
    const { token } = req.params;
    const { label, description, isActive, replyEnabled }: UpdateAliasInput = req.body;

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

    // Track disabledAt for auto-deletion scheduling
    let disabledAt: Date | null | undefined = undefined;
    if (isActive !== undefined) {
      if (isActive === false && alias.isActive === true) {
        // Being disabled - set disabledAt
        disabledAt = new Date();
      } else if (isActive === true && alias.isActive === false) {
        // Being re-enabled - clear disabledAt
        disabledAt = null;
      }
    }

    const updated = await prisma.alias.update({
      where: { id: alias.id },
      data: {
        ...(label !== undefined && { label }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
        ...(replyEnabled !== undefined && { replyEnabled }),
        ...(disabledAt !== undefined && { disabledAt }),
      },
      include: {
        domain: { select: { id: true, domain: true } },
      },
    });

    await invalidateAliasCache(alias.alias);

    logger.info(`Alias updated via token: ${updated.fullAddress}`);

    res.json({
      success: true,
      data: updated,
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
    const { token } = req.params;

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

    await invalidateAliasCache(alias.alias);

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
 * Block a sender for an alias
 */
export async function blockSender(req: Request, res: Response): Promise<void> {
  try {
    const { token } = req.params;
    const { email, reason } = req.body;

    if (!email || !isValidEmail(email)) {
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
          email: email.toLowerCase(),
        },
      },
      create: {
        aliasId: alias.id,
        email: email.toLowerCase(),
        reason: reason || null,
      },
      update: {
        reason: reason || null,
      },
    });

    logger.info(`Sender blocked for ${alias.fullAddress}: ${email}`);

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
    const { token, senderId } = req.params;

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
    const { destinationEmail, domainId, customAlias, label, description, expiresIn }: CreatePublicAliasInput = req.body;

    // Get user with their limits
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, maxAliases: true },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Use user's email if no destination provided
    const email = (destinationEmail || user.email).toLowerCase();

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

    // Get domain
    let domain = domainId ? await getDomainById(domainId) : await getDefaultDomain();
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
          error: 'Invalid alias format',
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

    const newAlias = await prisma.alias.create({
      data: {
        alias: aliasName,
        domainId: domain.id,
        fullAddress,
        destinationEmail: email,
        emailVerified: true, // Authenticated users are verified
        label: label || null,
        description: description || null,
        isActive: true,
        isPrivate: true,
        userId,
        replyPrefix,
        replyEnabled: true,
        expiresAt: expiresIn ? calculateExpiresAt(expiresIn) : null,
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

    logger.info(`Private alias created: ${fullAddress} for user ${req.user!.email}`);

    res.status(201).json({
      success: true,
      data: newAlias,
      message: 'Alias created successfully',
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
    const {
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      active,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const where: any = { userId };

    if (active !== undefined) {
      where.isActive = active === 'true';
    }

    const [aliases, total] = await Promise.all([
      prisma.alias.findMany({
        where,
        orderBy: { [sortBy as string]: sortOrder },
        skip,
        take: Number(limit),
        include: {
          domain: { select: { id: true, domain: true } },
        },
      }),
      prisma.alias.count({ where }),
    ]);

    const totalPages = Math.ceil(total / Number(limit));

    res.json({
      success: true,
      data: {
        items: aliases,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages,
          hasNext: Number(page) < totalPages,
          hasPrev: Number(page) > 1,
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
    const { id } = req.params;

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
      data: alias,
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
    const { id } = req.params;
    const { label, description, isActive, replyEnabled, expiresAt }: UpdateAliasInput = req.body;

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

    const updated = await prisma.alias.update({
      where: { id },
      data: {
        ...(label !== undefined && { label }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
        ...(replyEnabled !== undefined && { replyEnabled }),
        ...(expiresAt !== undefined && { expiresAt }),
      },
      include: {
        domain: { select: { id: true, domain: true } },
      },
    });

    await invalidateAliasCache(existing.alias);

    logger.info(`Alias updated: ${updated.fullAddress}`);

    res.json({
      success: true,
      data: updated,
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
    const { id } = req.params;

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

    await invalidateAliasCache(existing.alias);

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
    const { id } = req.params;

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

    const updated = await prisma.alias.update({
      where: { id },
      data: { isActive: !existing.isActive },
      include: {
        domain: { select: { id: true, domain: true } },
      },
    });

    await invalidateAliasCache(existing.alias);

    res.json({
      success: true,
      data: updated,
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
    const { page = 1, limit = 20, aliasId, status } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const where: any = { userId };

    if (aliasId) where.aliasId = aliasId;
    if (status) where.status = status;

    const [logs, total] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
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
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit)),
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
