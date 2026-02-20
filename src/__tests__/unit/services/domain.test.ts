/**
 * Domain Service Unit Tests
 *
 * Tests for domain management functionality
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock dependencies before imports
jest.mock('../../../services/database', () => ({
  __esModule: true,
  default: {
    domain: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    $connect: jest.fn(),
    $disconnect: jest.fn()
  }
}));

jest.mock('../../../services/redis', () => ({
  getCachedDomains: jest.fn<any>().mockResolvedValue(null),
  cacheDomains: jest.fn(),
  invalidateDomainsCache: jest.fn()
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

import prisma from '../../../services/database';
import * as redis from '../../../services/redis';
import {
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
} from '../../../services/domainService';

describe('Domain Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getActiveDomains', () => {
    it('should return cached domains if available', async () => {
      const cachedDomains = [
        { id: '1', domain: 'example.com', isDefault: true, aliasCount: 10 }
      ];
      (redis.getCachedDomains as jest.Mock<any>).mockResolvedValue(cachedDomains);

      const result = await getActiveDomains();

      expect(result).toEqual(cachedDomains);
      expect(prisma.domain.findMany).not.toHaveBeenCalled();
    });

    it('should query database and cache if no cache', async () => {
      const dbDomains = [
        { id: '1', domain: 'example.com', description: null, isDefault: true, aliasCount: 10 }
      ];
      (redis.getCachedDomains as jest.Mock<any>).mockResolvedValue(null);
      (prisma.domain.findMany as jest.Mock<any>).mockResolvedValue(dbDomains);

      const result = await getActiveDomains();

      expect(prisma.domain.findMany).toHaveBeenCalledWith({
        where: { isActive: true, isPublic: true },
        orderBy: [{ isDefault: 'desc' }, { domain: 'asc' }],
        select: {
          id: true,
          domain: true,
          description: true,
          isDefault: true,
          aliasCount: true,
        }
      });
    });

    it('should return empty array on database error', async () => {
      (redis.getCachedDomains as jest.Mock<any>).mockResolvedValue(null);
      (prisma.domain.findMany as jest.Mock<any>).mockRejectedValue(new Error('DB Error'));

      const result = await getActiveDomains();

      expect(result).toEqual([]);
    });
  });

  describe('getDomainById', () => {
    it('should return domain by ID', async () => {
      const domain = { id: '1', domain: 'example.com', isDefault: true };
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue(domain);

      const result = await getDomainById('1');

      expect(result).toEqual(domain);
      expect(prisma.domain.findUnique).toHaveBeenCalledWith({
        where: { id: '1' },
        select: expect.any(Object)
      });
    });

    it('should return null for non-existent ID', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue(null);

      const result = await getDomainById('nonexistent');

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockRejectedValue(new Error('DB Error'));

      const result = await getDomainById('1');

      expect(result).toBeNull();
    });
  });

  describe('getDomainByName', () => {
    it('should return domain by name', async () => {
      const domain = { id: '1', domain: 'example.com', isDefault: true };
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue(domain);

      const result = await getDomainByName('example.com');

      expect(result).toEqual(domain);
      expect(prisma.domain.findUnique).toHaveBeenCalledWith({
        where: { domain: 'example.com' },
        select: expect.any(Object)
      });
    });

    it('should convert domain name to lowercase', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue(null);

      await getDomainByName('Example.COM');

      expect(prisma.domain.findUnique).toHaveBeenCalledWith({
        where: { domain: 'example.com' },
        select: expect.any(Object)
      });
    });
  });

  describe('getDefaultDomain', () => {
    it('should return the default domain', async () => {
      const domains = [
        { id: '2', domain: 'other.com', isDefault: false },
        { id: '1', domain: 'example.com', isDefault: true }
      ];
      (redis.getCachedDomains as jest.Mock<any>).mockResolvedValue(domains);

      const result = await getDefaultDomain();

      expect(result?.isDefault).toBe(true);
    });

    it('should return first domain if no default', async () => {
      const domains = [
        { id: '1', domain: 'example.com', isDefault: false }
      ];
      (redis.getCachedDomains as jest.Mock<any>).mockResolvedValue(domains);

      const result = await getDefaultDomain();

      expect(result?.id).toBe('1');
    });

    it('should return null if no domains', async () => {
      (redis.getCachedDomains as jest.Mock<any>).mockResolvedValue([]);

      const result = await getDefaultDomain();

      expect(result).toBeNull();
    });
  });

  describe('createDomain', () => {
    it('should create a new domain', async () => {
      const newDomain = {
        id: '1',
        domain: 'newdomain.com',
        description: 'Test domain',
        isDefault: false,
        aliasCount: 0
      };
      (prisma.domain.create as jest.Mock<any>).mockResolvedValue(newDomain);

      const result = await createDomain({
        domain: 'newdomain.com',
        description: 'Test domain'
      });

      expect(result).toEqual(newDomain);
      expect(redis.invalidateDomainsCache).toHaveBeenCalled();
    });

    it('should unset other defaults when creating default domain', async () => {
      const newDomain = { id: '1', domain: 'default.com', isDefault: true };
      (prisma.domain.updateMany as jest.Mock<any>).mockResolvedValue({ count: 1 });
      (prisma.domain.create as jest.Mock<any>).mockResolvedValue(newDomain);

      await createDomain({ domain: 'default.com', isDefault: true });

      expect(prisma.domain.updateMany).toHaveBeenCalledWith({
        where: { isDefault: true },
        data: { isDefault: false }
      });
    });

    it('should convert domain to lowercase', async () => {
      (prisma.domain.create as jest.Mock<any>).mockResolvedValue({ domain: 'example.com' });

      await createDomain({ domain: 'EXAMPLE.COM' });

      expect(prisma.domain.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          domain: 'example.com'
        }),
        select: expect.any(Object)
      });
    });

    it('should return null on error', async () => {
      (prisma.domain.create as jest.Mock<any>).mockRejectedValue(new Error('DB Error'));

      const result = await createDomain({ domain: 'example.com' });

      expect(result).toBeNull();
    });
  });

  describe('updateDomain', () => {
    it('should update domain', async () => {
      const updatedDomain = { id: '1', domain: 'updated.com', isDefault: false };
      (prisma.domain.update as jest.Mock<any>).mockResolvedValue(updatedDomain);

      const result = await updateDomain('1', { domain: 'updated.com' });

      expect(result).toEqual(updatedDomain);
      expect(redis.invalidateDomainsCache).toHaveBeenCalled();
    });

    it('should unset other defaults when setting as default', async () => {
      (prisma.domain.updateMany as jest.Mock<any>).mockResolvedValue({ count: 1 });
      (prisma.domain.update as jest.Mock<any>).mockResolvedValue({ id: '1', isDefault: true });

      await updateDomain('1', { isDefault: true });

      expect(prisma.domain.updateMany).toHaveBeenCalledWith({
        where: { isDefault: true, id: { not: '1' } },
        data: { isDefault: false }
      });
    });

    it('should return null on error', async () => {
      (prisma.domain.update as jest.Mock<any>).mockRejectedValue(new Error('DB Error'));

      const result = await updateDomain('1', { description: 'test' });

      expect(result).toBeNull();
    });
  });

  describe('deleteDomain', () => {
    it('should delete domain with no aliases', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue({
        domain: 'example.com',
        aliasCount: 0
      });
      (prisma.domain.delete as jest.Mock<any>).mockResolvedValue({});

      const result = await deleteDomain('1');

      expect(result).toBe(true);
      expect(prisma.domain.delete).toHaveBeenCalled();
      expect(redis.invalidateDomainsCache).toHaveBeenCalled();
    });

    it('should not delete domain with aliases', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue({
        domain: 'example.com',
        aliasCount: 5
      });

      const result = await deleteDomain('1');

      expect(result).toBe(false);
      expect(prisma.domain.delete).not.toHaveBeenCalled();
    });

    it('should return false for non-existent domain', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue(null);

      const result = await deleteDomain('nonexistent');

      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockRejectedValue(new Error('DB Error'));

      const result = await deleteDomain('1');

      expect(result).toBe(false);
    });
  });

  describe('toggleDomainStatus', () => {
    it('should toggle domain from active to inactive', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue({ isActive: true });
      (prisma.domain.update as jest.Mock<any>).mockResolvedValue({ id: '1', isActive: false });

      const result = await toggleDomainStatus('1');

      expect(prisma.domain.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { isActive: false },
        select: expect.any(Object)
      });
    });

    it('should toggle domain from inactive to active', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue({ isActive: false });
      (prisma.domain.update as jest.Mock<any>).mockResolvedValue({ id: '1', isActive: true });

      const result = await toggleDomainStatus('1');

      expect(prisma.domain.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { isActive: true },
        select: expect.any(Object)
      });
    });

    it('should return null for non-existent domain', async () => {
      (prisma.domain.findUnique as jest.Mock<any>).mockResolvedValue(null);

      const result = await toggleDomainStatus('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('incrementDomainAliasCount', () => {
    it('should increment alias count', async () => {
      (prisma.domain.update as jest.Mock<any>).mockResolvedValue({});

      await incrementDomainAliasCount('domain-1');

      expect(prisma.domain.update).toHaveBeenCalledWith({
        where: { id: 'domain-1' },
        data: { aliasCount: { increment: 1 } }
      });
      expect(redis.invalidateDomainsCache).toHaveBeenCalled();
    });
  });

  describe('decrementDomainAliasCount', () => {
    it('should decrement alias count', async () => {
      (prisma.domain.update as jest.Mock<any>).mockResolvedValue({});

      await decrementDomainAliasCount('domain-1');

      expect(prisma.domain.update).toHaveBeenCalledWith({
        where: { id: 'domain-1' },
        data: { aliasCount: { decrement: 1 } }
      });
      expect(redis.invalidateDomainsCache).toHaveBeenCalled();
    });
  });
});

describe('Domain Validation', () => {
  describe('Domain Name Format', () => {
    it('should accept valid domain names', () => {
      const validDomains = [
        'example.com',
        'sub.example.com',
        'mail.sub.example.org',
        'my-domain.co.uk',
        'test123.io'
      ];

      const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

      for (const domain of validDomains) {
        expect(domainRegex.test(domain)).toBe(true);
      }
    });

    it('should reject invalid domain names', () => {
      const invalidDomains = [
        '',
        'localhost',
        '.example.com',
        'example.',
        '-example.com',
        'example-.com',
        'exam ple.com',
        'example..com'
      ];

      const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

      for (const domain of invalidDomains) {
        expect(domainRegex.test(domain)).toBe(false);
      }
    });
  });
});
