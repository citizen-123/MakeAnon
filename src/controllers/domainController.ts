import { Request, Response } from 'express';
import {
  getActiveDomains,
  getDomainById,
  createDomain,
  updateDomain,
  deleteDomain,
  toggleDomainStatus,
} from '../services/domainService';
import { AuthenticatedRequest } from '../types';
import logger from '../utils/logger';

/**
 * Get all active domains (public)
 */
export async function listDomains(req: Request, res: Response): Promise<void> {
  try {
    const domains = await getActiveDomains();

    res.json({
      success: true,
      data: domains,
    });
  } catch (error) {
    logger.error('List domains error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get domains',
    });
  }
}

/**
 * Get domain by ID (public)
 */
export async function getDomain(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const domain = await getDomainById(id);

    if (!domain) {
      res.status(404).json({
        success: false,
        error: 'Domain not found',
      });
      return;
    }

    res.json({
      success: true,
      data: domain,
    });
  } catch (error) {
    logger.error('Get domain error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get domain',
    });
  }
}

// ============================================================================
// Admin Only
// ============================================================================

/**
 * Create a new domain (admin only)
 */
export async function createDomainHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.isAdmin) {
      res.status(403).json({
        success: false,
        error: 'Admin access required',
      });
      return;
    }

    const { domain, description, isDefault, isPublic } = req.body;

    if (!domain) {
      res.status(400).json({
        success: false,
        error: 'Domain name is required',
      });
      return;
    }

    const newDomain = await createDomain({ domain, description, isDefault, isPublic });

    if (!newDomain) {
      res.status(400).json({
        success: false,
        error: 'Failed to create domain. It may already exist.',
      });
      return;
    }

    res.status(201).json({
      success: true,
      data: newDomain,
      message: 'Domain created successfully',
    });
  } catch (error) {
    logger.error('Create domain error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create domain',
    });
  }
}

/**
 * Update a domain (admin only)
 */
export async function updateDomainHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.isAdmin) {
      res.status(403).json({
        success: false,
        error: 'Admin access required',
      });
      return;
    }

    const { id } = req.params;
    const { description, isDefault, isPublic } = req.body;

    const updated = await updateDomain(id, { description, isDefault, isPublic });

    if (!updated) {
      res.status(404).json({
        success: false,
        error: 'Domain not found',
      });
      return;
    }

    res.json({
      success: true,
      data: updated,
      message: 'Domain updated successfully',
    });
  } catch (error) {
    logger.error('Update domain error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update domain',
    });
  }
}

/**
 * Delete a domain (admin only)
 */
export async function deleteDomainHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.isAdmin) {
      res.status(403).json({
        success: false,
        error: 'Admin access required',
      });
      return;
    }

    const { id } = req.params;

    const deleted = await deleteDomain(id);

    if (!deleted) {
      res.status(400).json({
        success: false,
        error: 'Failed to delete domain. It may have aliases or not exist.',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Domain deleted successfully',
    });
  } catch (error) {
    logger.error('Delete domain error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete domain',
    });
  }
}

/**
 * Toggle domain status (admin only)
 */
export async function toggleDomainHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.user?.isAdmin) {
      res.status(403).json({
        success: false,
        error: 'Admin access required',
      });
      return;
    }

    const { id } = req.params;

    const updated = await toggleDomainStatus(id);

    if (!updated) {
      res.status(404).json({
        success: false,
        error: 'Domain not found',
      });
      return;
    }

    res.json({
      success: true,
      data: updated,
      message: 'Domain status toggled successfully',
    });
  } catch (error) {
    logger.error('Toggle domain error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to toggle domain',
    });
  }
}
