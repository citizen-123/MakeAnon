/**
 * Prisma Client Mock
 *
 * Provides a mock implementation of the Prisma client for testing
 */

import { jest } from '@jest/globals';

// Mock data stores
export const mockData = {
  users: new Map<string, any>(),
  aliases: new Map<string, any>(),
  domains: new Map<string, any>(),
  blockedSenders: new Map<string, any>(),
  verificationTokens: new Map<string, any>(),
  emailLogs: new Map<string, any>()
};

// Helper to reset all mock data
export const resetMockData = () => {
  mockData.users.clear();
  mockData.aliases.clear();
  mockData.domains.clear();
  mockData.blockedSenders.clear();
  mockData.verificationTokens.clear();
  mockData.emailLogs.clear();
};

// Mock Prisma client
export const mockPrismaClient = {
  $connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  $disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),

  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn()
  },

  alias: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn()
  },

  domain: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn()
  },

  blockedSender: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn()
  },

  verificationToken: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn()
  },

  emailLog: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn()
  }
};

// Default export for jest.mock
export default mockPrismaClient;

// Factory function to create fresh mock
export const createMockPrismaClient = () => {
  resetMockData();
  return { ...mockPrismaClient };
};
