import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../services/database';
import { authenticate } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
import { hashEmail } from '../utils/encryption';
import { invalidateAliasCache } from '../services/redis';
import { deleteAliasesWhere, invalidateUserAliasCaches } from '../services/aliasCleanup';
import { parsePagination } from '../utils/helpers';
import logger from '../utils/logger';

/**
 * Admin-safe alias fields. Deliberately excludes managementToken, replyPrefix
 * and the destination ciphertext/iv/salt/authTag/hash.
 */
const ADMIN_ALIAS_SELECT = {
  id: true,
  alias: true,
  fullAddress: true,
  domainId: true,
  emailVerified: true,
  label: true,
  description: true,
  isActive: true,
  isPrivate: true,
  forwardCount: true,
  lastForwardAt: true,
  blockedCount: true,
  disabledAt: true,
  replyEnabled: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
  expiresAt: true,
  domain: { select: { domain: true } },
} as const;

/**
 * Admin-safe user fields (no password hash, no email ciphertext)
 */
const ADMIN_USER_SELECT = {
  id: true,
  name: true,
  isActive: true,
  isAdmin: true,
  emailVerified: true,
  maxAliases: true,
  createdAt: true,
} as const;

const router = Router();

// All routes require authentication and admin privileges
router.use(authenticate);

// Middleware to check admin status
router.use((req: AuthenticatedRequest, res: Response, next) => {
  if (!req.user?.isAdmin) {
    res.status(403).json({
      success: false,
      error: 'Admin access required',
    });
    return;
  }
  next();
});

// ============================================================================
// Dashboard Stats
// ============================================================================

router.get('/stats', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const [
      totalAliases,
      activeAliases,
      totalUsers,
      totalDomains,
      aliasesToday,
      usersToday,
      emailsToday,
      emailsThisWeek,
      topDomains,
    ] = await Promise.all([
      prisma.alias.count(),
      prisma.alias.count({ where: { isActive: true } }),
      prisma.user.count(),
      prisma.domain.count(),
      prisma.alias.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.emailLog.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.emailLog.count({ where: { createdAt: { gte: weekStart } } }),
      prisma.domain.findMany({
        select: { domain: true, aliasCount: true },
        orderBy: { aliasCount: 'desc' },
        take: 5,
      }),
    ]);

    res.json({
      success: true,
      data: {
        totalAliases,
        activeAliases,
        totalUsers,
        totalDomains,
        newAliasesToday: aliasesToday,
        newUsersToday: usersToday,
        emailsToday,
        emailsThisWeek,
        topDomains: topDomains.map((d) => ({ domain: d.domain, count: d.aliasCount })),
      },
    });
  } catch (error) {
    logger.error('Admin stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

// ============================================================================
// User Management
// ============================================================================

router.get('/users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { search } = req.query;
    const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20, 100);

    // Emails are encrypted at rest: an email search is an exact match on the HMAC
    let where = {};
    if (typeof search === 'string' && search.length > 0 && search.length <= 320) {
      where = search.includes('@')
        ? { emailHash: hashEmail(search) }
        : { name: { contains: search } };
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          ...ADMIN_USER_SELECT,
          _count: { select: { aliases: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        items: users.map(({ _count, ...u }) => ({ ...u, aliasCount: _count.aliases })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logger.error('Admin list users error:', error);
    res.status(500).json({ success: false, error: 'Failed to get users' });
  }
});

router.put('/users/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { isActive, isAdmin, maxAliases } = (req.body || {}) as Record<string, unknown>;

    if (
      (isActive !== undefined && typeof isActive !== 'boolean') ||
      (isAdmin !== undefined && typeof isAdmin !== 'boolean') ||
      (maxAliases !== undefined &&
        (typeof maxAliases !== 'number' || !Number.isInteger(maxAliases) || maxAliases < 0 || maxAliases > 100000))
    ) {
      res.status(400).json({ success: false, error: 'Invalid user update' });
      return;
    }

    // Prevent self-demotion
    if (id === req.user!.id && isAdmin === false) {
      res.status(400).json({
        success: false,
        error: 'Cannot remove your own admin privileges',
      });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(isActive !== undefined && { isActive: isActive as boolean }),
        ...(isAdmin !== undefined && { isAdmin: isAdmin as boolean }),
        ...(maxAliases !== undefined && { maxAliases: maxAliases as number }),
      },
      select: ADMIN_USER_SELECT,
    });

    // Activation changes affect whether the user's aliases forward; drop cached
    // alias records so the mail path re-reads owner state.
    if (isActive !== undefined) {
      await invalidateUserAliasCaches(id);
    }

    res.json({
      success: true,
      data: user,
      message: 'User updated successfully',
    });
  } catch (error) {
    logger.error('Admin update user error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// ============================================================================
// Alias Management
// ============================================================================

router.get('/aliases', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { search, active } = req.query;
    const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 20, 100);

    const where: Prisma.AliasWhereInput = {};
    if (typeof search === 'string' && search.length > 0 && search.length <= 320) {
      where.OR = [
        { alias: { contains: search } },
        { fullAddress: { contains: search } },
      ];
      // destinationEmail is encrypted — use hash-based exact match for email searches
      if (search.includes('@')) {
        where.OR.push({ destinationHash: hashEmail(search) });
      }
    }
    if (typeof active === 'string') {
      where.isActive = active === 'true';
    }

    const [aliases, total] = await Promise.all([
      prisma.alias.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: ADMIN_ALIAS_SELECT,
      }),
      prisma.alias.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        items: aliases,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logger.error('Admin list aliases error:', error);
    res.status(500).json({ success: false, error: 'Failed to get aliases' });
  }
});

router.delete('/aliases/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const alias = await prisma.alias.findUnique({ where: { id } });
    if (!alias) {
      res.status(404).json({ success: false, error: 'Alias not found' });
      return;
    }

    await prisma.alias.delete({ where: { id } });
    await prisma.domain.update({
      where: { id: alias.domainId },
      data: { aliasCount: { decrement: 1 } },
    });
    await invalidateAliasCache(alias.fullAddress);

    logger.info(`Admin deleted alias: ${alias.fullAddress}`);

    res.json({ success: true, message: 'Alias deleted successfully' });
  } catch (error) {
    logger.error('Admin delete alias error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete alias' });
  }
});

// ============================================================================
// Email Logs
// ============================================================================

router.get('/logs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status, search } = req.query;
    const { page, limit, skip } = parsePagination(req.query.page, req.query.limit, 50, 100);

    const where: Prisma.EmailLogWhereInput = {};
    if (typeof status === 'string' && status.length > 0) where.status = status;
    if (typeof search === 'string' && search.length > 0 && search.length <= 320) {
      where.OR = [
        { toAlias: { contains: search } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          alias: { select: { fullAddress: true, label: true } },
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
    logger.error('Admin list logs error:', error);
    res.status(500).json({ success: false, error: 'Failed to get logs' });
  }
});

// ============================================================================
// System
// ============================================================================

router.post('/cleanup', async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Clean expired tokens
    const expiredTokens = await prisma.verificationToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    // Clean expired aliases if configured
    let expiredAliases = 0;
    if (process.env.DELETE_EXPIRED_ALIASES === 'true') {
      expiredAliases = await deleteAliasesWhere({ expiresAt: { lt: new Date() } });
    }

    // Clean old logs if configured
    let oldLogs = 0;
    const logRetentionDays = parseInt(process.env.LOG_RETENTION_DAYS || '30');
    if (logRetentionDays > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - logRetentionDays);
      const result = await prisma.emailLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      oldLogs = result.count;
    }

    res.json({
      success: true,
      data: {
        expiredTokens: expiredTokens.count,
        expiredAliases,
        oldLogs,
      },
      message: 'Cleanup completed successfully',
    });
  } catch (error) {
    logger.error('Admin cleanup error:', error);
    res.status(500).json({ success: false, error: 'Cleanup failed' });
  }
});

export default router;
