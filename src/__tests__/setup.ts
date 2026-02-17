/**
 * Jest Test Setup
 *
 * This file runs before all tests to set up the test environment
 */

import { jest, afterAll } from '@jest/globals';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only-32chars';
process.env.MASTER_ENCRYPTION_KEY = 'deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb';
process.env.EMAIL_DOMAINS = 'test.example.com,alias.test.com';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.BASE_URL = 'https://test.example.com';
process.env.SMTP_OUTBOUND_HOST = 'localhost';
process.env.SMTP_OUTBOUND_PORT = '2525';
process.env.SMTP_FROM_ADDRESS = 'noreply@test.example.com';
process.env.SMTP_FROM_NAME = 'Test MakeAnon';

// Increase timeout for async operations
jest.setTimeout(10000);

// Global test utilities
declare global {
  namespace NodeJS {
    interface Global {
      testUtils: {
        generateRandomEmail: () => string;
        generateRandomAlias: () => string;
        wait: (ms: number) => Promise<void>;
      };
    }
  }
}

// Add test utilities to global
(global as any).testUtils = {
  generateRandomEmail: () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  generateRandomAlias: () => `alias-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
};

// Suppress console output during tests (optional)
// Uncomment the following to suppress logs during tests
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
// };

// Clean up after all tests
afterAll(async () => {
  // Allow any pending operations to complete
  await new Promise(resolve => setTimeout(resolve, 100));
});
