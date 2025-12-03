import { Router } from 'express';
import authRoutes from './authRoutes';
import aliasRoutes from './aliasRoutes';
import publicRoutes from './publicRoutes';
import domainRoutes from './domainRoutes';
import adminRoutes from './adminRoutes';
import prisma from '../services/database';
import { isRedisConnected } from '../services/redis';
import { getCachedStats, cacheStats } from '../services/redis';

const router = Router();

// Public routes (no auth required)
router.use('/', publicRoutes);

// Auth routes
router.use('/auth', authRoutes);

// Alias routes (mix of public and private)
router.use('/aliases', aliasRoutes);

// Domain routes
router.use('/domains', domainRoutes);

// Admin routes
router.use('/admin', adminRoutes);

// Health check
router.get('/health', async (_req, res) => {
  const dbHealthy = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  const redisHealthy = isRedisConnected();

  const status = dbHealthy ? (redisHealthy ? 'healthy' : 'degraded') : 'unhealthy';

  res.status(status === 'unhealthy' ? 503 : 200).json({
    success: status !== 'unhealthy',
    status,
    checks: {
      database: dbHealthy,
      redis: redisHealthy,
    },
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '2.0.0',
  });
});

// Global statistics (public)
router.get('/stats', async (_req, res) => {
  try {
    // Try cache first
    const cached = await getCachedStats();
    if (cached) {
      res.json({ success: true, data: cached });
      return;
    }

    const [totalAliases, activeAliases, totalUsers, domainsCount] = await Promise.all([
      prisma.alias.count(),
      prisma.alias.count({ where: { isActive: true } }),
      prisma.user.count(),
      prisma.domain.count({ where: { isActive: true } }),
    ]);

    const stats = {
      totalAliases,
      activeAliases,
      totalUsers,
      domainsCount,
    };

    await cacheStats(stats);

    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get statistics' });
  }
});

export default router;
