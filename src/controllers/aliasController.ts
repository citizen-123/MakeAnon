import { Response } from 'express';
import prisma from '../services/database';
import { AuthenticatedRequest, CreateAliasInput, UpdateAliasInput } from '../types';
import { generateAlias, createFullAliasEmail } from '../utils/helpers';
import logger from '../utils/logger';

const MAX_ALIASES = parseInt(process.env.MAX_ALIASES_PER_USER || '50');

export async function createAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { label, description }: CreateAliasInput = req.body;

    // Check alias limit
    const aliasCount = await prisma.alias.count({
      where: { userId },
    });

    if (aliasCount >= MAX_ALIASES) {
      res.status(400).json({
        success: false,
        error: `Maximum number of aliases (${MAX_ALIASES}) reached`,
      });
      return;
    }

    // Generate unique alias
    let alias: string;
    let fullAddress: string;
    let attempts = 0;
    const maxAttempts = 10;

    do {
      alias = generateAlias();
      fullAddress = createFullAliasEmail(alias);
      const existing = await prisma.alias.findUnique({
        where: { alias },
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

    // Create alias
    const newAlias = await prisma.alias.create({
      data: {
        alias,
        fullAddress,
        label: label || null,
        description: description || null,
        userId,
      },
    });

    logger.info(`Alias created: ${fullAddress} for user ${req.user!.email}`);

    res.status(201).json({
      success: true,
      data: newAlias,
      message: 'Alias created successfully',
    });
  } catch (error) {
    logger.error('Create alias error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create alias',
    });
  }
}

export async function getAliases(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const {
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const [aliases, total] = await Promise.all([
      prisma.alias.findMany({
        where: { userId },
        orderBy: { [sortBy as string]: sortOrder },
        skip,
        take: Number(limit),
      }),
      prisma.alias.count({ where: { userId } }),
    ]);

    res.json({
      success: true,
      data: {
        aliases,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit)),
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

export async function getAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const alias = await prisma.alias.findFirst({
      where: { id, userId },
      include: {
        emailLogs: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
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

export async function updateAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { label, description, isActive }: UpdateAliasInput = req.body;

    // Check ownership
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

    // Update alias
    const updatedAlias = await prisma.alias.update({
      where: { id },
      data: {
        ...(label !== undefined && { label }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    logger.info(`Alias updated: ${updatedAlias.fullAddress}`);

    res.json({
      success: true,
      data: updatedAlias,
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

export async function deleteAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Check ownership
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

    // Delete alias
    await prisma.alias.delete({
      where: { id },
    });

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

export async function toggleAlias(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Check ownership
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

    // Toggle active status
    const updatedAlias = await prisma.alias.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });

    logger.info(`Alias toggled: ${updatedAlias.fullAddress} -> ${updatedAlias.isActive ? 'active' : 'inactive'}`);

    res.json({
      success: true,
      data: updatedAlias,
      message: `Alias ${updatedAlias.isActive ? 'activated' : 'deactivated'} successfully`,
    });
  } catch (error) {
    logger.error('Toggle alias error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to toggle alias',
    });
  }
}

export async function getStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

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
        maxAliases: MAX_ALIASES,
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

export async function getEmailLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { page = 1, limit = 20 } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const [logs, total] = await Promise.all([
      prisma.emailLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
        include: {
          alias: {
            select: {
              alias: true,
              fullAddress: true,
              label: true,
            },
          },
        },
      }),
      prisma.emailLog.count({ where: { userId } }),
    ]);

    res.json({
      success: true,
      data: {
        logs,
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
