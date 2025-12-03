import prisma from './database';
import { invalidateDomainsCache, cacheDomains, getCachedDomains } from './redis';
import { DomainInfo, CreateDomainInput } from '../types';
import logger from '../utils/logger';

/**
 * Get all active domains (with caching)
 */
export async function getActiveDomains(): Promise<DomainInfo[]> {
  // Try cache first
  const cached = await getCachedDomains<DomainInfo[]>();
  if (cached) return cached;

  try {
    const domains = await prisma.domain.findMany({
      where: { isActive: true, isPublic: true },
      orderBy: [{ isDefault: 'desc' }, { domain: 'asc' }],
      select: {
        id: true,
        domain: true,
        description: true,
        isDefault: true,
        aliasCount: true,
      },
    });

    // Cache the result
    await cacheDomains(domains);

    return domains;
  } catch (error) {
    logger.error('Failed to get active domains:', error);
    return [];
  }
}

/**
 * Get domain by ID
 */
export async function getDomainById(id: string): Promise<DomainInfo | null> {
  try {
    const domain = await prisma.domain.findUnique({
      where: { id },
      select: {
        id: true,
        domain: true,
        description: true,
        isDefault: true,
        aliasCount: true,
      },
    });
    return domain;
  } catch (error) {
    logger.error('Failed to get domain by ID:', error);
    return null;
  }
}

/**
 * Get domain by domain name
 */
export async function getDomainByName(domainName: string): Promise<DomainInfo | null> {
  try {
    const domain = await prisma.domain.findUnique({
      where: { domain: domainName.toLowerCase() },
      select: {
        id: true,
        domain: true,
        description: true,
        isDefault: true,
        aliasCount: true,
      },
    });
    return domain;
  } catch (error) {
    logger.error('Failed to get domain by name:', error);
    return null;
  }
}

/**
 * Get the default domain
 */
export async function getDefaultDomain(): Promise<DomainInfo | null> {
  const domains = await getActiveDomains();
  return domains.find((d) => d.isDefault) || domains[0] || null;
}

/**
 * Create a new domain (admin only)
 */
export async function createDomain(input: CreateDomainInput): Promise<DomainInfo | null> {
  try {
    // If setting as default, unset other defaults first
    if (input.isDefault) {
      await prisma.domain.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    const domain = await prisma.domain.create({
      data: {
        domain: input.domain.toLowerCase(),
        description: input.description,
        isDefault: input.isDefault || false,
        isPublic: input.isPublic !== false,
      },
      select: {
        id: true,
        domain: true,
        description: true,
        isDefault: true,
        aliasCount: true,
      },
    });

    // Invalidate cache
    await invalidateDomainsCache();

    logger.info(`Domain created: ${domain.domain}`);
    return domain;
  } catch (error) {
    logger.error('Failed to create domain:', error);
    return null;
  }
}

/**
 * Update a domain (admin only)
 */
export async function updateDomain(
  id: string,
  data: Partial<CreateDomainInput>
): Promise<DomainInfo | null> {
  try {
    // If setting as default, unset other defaults first
    if (data.isDefault) {
      await prisma.domain.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    const domain = await prisma.domain.update({
      where: { id },
      data: {
        ...(data.domain && { domain: data.domain.toLowerCase() }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
        ...(data.isPublic !== undefined && { isPublic: data.isPublic }),
      },
      select: {
        id: true,
        domain: true,
        description: true,
        isDefault: true,
        aliasCount: true,
      },
    });

    // Invalidate cache
    await invalidateDomainsCache();

    logger.info(`Domain updated: ${domain.domain}`);
    return domain;
  } catch (error) {
    logger.error('Failed to update domain:', error);
    return null;
  }
}

/**
 * Delete a domain (admin only)
 */
export async function deleteDomain(id: string): Promise<boolean> {
  try {
    // Check if domain has aliases
    const domain = await prisma.domain.findUnique({
      where: { id },
      select: { aliasCount: true, domain: true },
    });

    if (!domain) {
      return false;
    }

    if (domain.aliasCount > 0) {
      logger.warn(`Cannot delete domain ${domain.domain} - has ${domain.aliasCount} aliases`);
      return false;
    }

    await prisma.domain.delete({ where: { id } });

    // Invalidate cache
    await invalidateDomainsCache();

    logger.info(`Domain deleted: ${domain.domain}`);
    return true;
  } catch (error) {
    logger.error('Failed to delete domain:', error);
    return false;
  }
}

/**
 * Toggle domain active status (admin only)
 */
export async function toggleDomainStatus(id: string): Promise<DomainInfo | null> {
  try {
    const current = await prisma.domain.findUnique({
      where: { id },
      select: { isActive: true },
    });

    if (!current) return null;

    const domain = await prisma.domain.update({
      where: { id },
      data: { isActive: !current.isActive },
      select: {
        id: true,
        domain: true,
        description: true,
        isDefault: true,
        aliasCount: true,
      },
    });

    // Invalidate cache
    await invalidateDomainsCache();

    return domain;
  } catch (error) {
    logger.error('Failed to toggle domain status:', error);
    return null;
  }
}

/**
 * Increment alias count for a domain
 */
export async function incrementDomainAliasCount(domainId: string): Promise<void> {
  try {
    await prisma.domain.update({
      where: { id: domainId },
      data: { aliasCount: { increment: 1 } },
    });
    await invalidateDomainsCache();
  } catch (error) {
    logger.error('Failed to increment domain alias count:', error);
  }
}

/**
 * Decrement alias count for a domain
 */
export async function decrementDomainAliasCount(domainId: string): Promise<void> {
  try {
    await prisma.domain.update({
      where: { id: domainId },
      data: { aliasCount: { decrement: 1 } },
    });
    await invalidateDomainsCache();
  } catch (error) {
    logger.error('Failed to decrement domain alias count:', error);
  }
}

/**
 * Initialize domains from environment variable
 */
export async function initializeDomainsFromEnv(): Promise<void> {
  const domainsEnv = process.env.EMAIL_DOMAINS;
  if (!domainsEnv) return;

  const domains = domainsEnv.split(',').map((d) => d.trim().toLowerCase());

  for (let i = 0; i < domains.length; i++) {
    const domainName = domains[i];
    const existing = await getDomainByName(domainName);

    if (!existing) {
      await createDomain({
        domain: domainName,
        isDefault: i === 0,
        isPublic: true,
      });
      logger.info(`Initialized domain from env: ${domainName}`);
    }
  }
}

export default {
  getActiveDomains,
  getDomainById,
  getDomainByName,
  getDefaultDomain,
  createDomain,
  updateDomain,
  deleteDomain,
  toggleDomainStatus,
  incrementDomainAliasCount,
  decrementDomainAliasCount,
  initializeDomainsFromEnv,
};
