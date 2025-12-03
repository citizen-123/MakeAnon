import { Router, Response } from 'express';
import prisma from '../services/database';
import { authenticate } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
import logger from '../utils/logger';

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
    const { page = 1, limit = 20, search } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = search
      ? {
          OR: [
            { email: { contains: String(search) } },
            { name: { contains: String(search) } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          isAdmin: true,
          emailVerified: true,
          maxAliases: true,
          createdAt: true,
          _count: { select: { aliases: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        items: users.map((u) => ({ ...u, aliasCount: u._count.aliases })),
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit)),
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
    const { id } = req.params;
    const { isActive, isAdmin, maxAliases } = req.body;

    // Prevent self-demotion
    if (id === req.user!.id && isAdmin === false) {
      res.status(400).json({
        success: false,
        error: 'Cannot remove your own admin privileges',
      });
      return;
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(isActive !== undefined && { isActive }),
        ...(isAdmin !== undefined && { isAdmin }),
        ...(maxAliases !== undefined && { maxAliases }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        isAdmin: true,
        maxAliases: true,
      },
    });

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
    const { page = 1, limit = 20, search, active } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (search) {
      where.OR = [
        { alias: { contains: String(search) } },
        { fullAddress: { contains: String(search) } },
        { destinationEmail: { contains: String(search) } },
      ];
    }
    if (active !== undefined) {
      where.isActive = active === 'true';
    }

    const [aliases, total] = await Promise.all([
      prisma.alias.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          domain: { select: { domain: true } },
          user: { select: { email: true } },
        },
      }),
      prisma.alias.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        items: aliases,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit)),
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
    const { id } = req.params;

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
    const { page = 1, limit = 50, status, search } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { fromEmail: { contains: String(search) } },
        { toAlias: { contains: String(search) } },
        { subject: { contains: String(search) } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        skip,
        take: Number(limit),
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
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit)),
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
      const result = await prisma.alias.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      expiredAliases = result.count;
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
