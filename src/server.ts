import dotenv from 'dotenv';

// Load environment variables first
dotenv.config();

import app from './app';
import { startSmtpServer, stopSmtpServer } from './services/smtpServer';
import { verifyConnection } from './services/emailService';
import { connectRedis, disconnectRedis } from './services/redis';
import { initializeDomainsFromEnv } from './services/domainService';
import prisma from './services/database';
import logger from './utils/logger';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  try {
    logger.info('Starting MakeAnon Email Masking Service...');

    // Connect to Redis (optional but recommended)
    const redisConnected = await connectRedis();
    if (!redisConnected) {
      logger.warn('Redis not connected. Rate limiting and caching will be limited.');
    }

    // Initialize domains from environment variable
    await initializeDomainsFromEnv();

    // Verify outbound SMTP connection
    if (process.env.SMTP_OUTBOUND_HOST) {
      const smtpConnected = await verifyConnection();
      if (!smtpConnected) {
        logger.warn('Outbound SMTP connection could not be verified. Email forwarding may not work.');
      }
    } else {
      logger.warn('Outbound SMTP host not configured. Email forwarding will not work.');
    }

    // Start HTTP API server
    const server = app.listen(PORT, HOST, () => {
      logger.info(`MakeAnon API server running on http://${HOST}:${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`API Documentation: http://${HOST}:${PORT}/api/v1/health`);
    });

    // Start SMTP server for receiving emails
    const smtpEnabled = process.env.SMTP_ENABLED !== 'false';
    if (smtpEnabled) {
      try {
        startSmtpServer();
      } catch (error) {
        logger.error('Failed to start SMTP server:', error);
        logger.warn('SMTP server disabled. You can still use the API, but email receiving won\'t work.');
      }
    } else {
      logger.info('SMTP server disabled by configuration');
    }

    // Schedule cleanup job
    const cleanupInterval = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '1') * 60 * 60 * 1000;
    const cleanupJob = setInterval(async () => {
      try {
        // Clean expired verification tokens
        await prisma.verificationToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

        // Clean expired aliases if configured
        if (process.env.DELETE_EXPIRED_ALIASES === 'true') {
          await prisma.alias.deleteMany({
            where: { expiresAt: { lt: new Date() } },
          });
        }

        // Delete unverified aliases after 72 hours
        const unverifiedCutoff = new Date();
        unverifiedCutoff.setHours(unverifiedCutoff.getHours() - 72);
        const deletedUnverified = await prisma.alias.deleteMany({
          where: {
            emailVerified: false,
            createdAt: { lt: unverifiedCutoff },
          },
        });
        if (deletedUnverified.count > 0) {
          logger.info(`Deleted ${deletedUnverified.count} unverified aliases (72H expiry)`);
        }

        // Delete disabled aliases after 30 days
        const disabledCutoff = new Date();
        disabledCutoff.setDate(disabledCutoff.getDate() - 30);
        const deletedDisabled = await prisma.alias.deleteMany({
          where: {
            isActive: false,
            disabledAt: { lt: disabledCutoff },
          },
        });
        if (deletedDisabled.count > 0) {
          logger.info(`Deleted ${deletedDisabled.count} disabled aliases (30D expiry)`);
        }

        // Clean old logs if configured
        const logRetentionDays = parseInt(process.env.LOG_RETENTION_DAYS || '30');
        if (logRetentionDays > 0) {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - logRetentionDays);
          await prisma.emailLog.deleteMany({
            where: { createdAt: { lt: cutoff } },
          });
        }

        logger.debug('Cleanup job completed');
      } catch (error) {
        logger.error('Cleanup job failed:', error);
      }
    }, cleanupInterval);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received. Starting graceful shutdown...`);

      // Stop cleanup job
      clearInterval(cleanupJob);

      // Stop accepting new connections
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Stop SMTP server
      try {
        await stopSmtpServer();
      } catch (error) {
        logger.error('Error stopping SMTP server:', error);
      }

      // Disconnect Redis
      await disconnectRedis();

      // Disconnect database
      await prisma.$disconnect();

      // Give existing connections time to complete
      setTimeout(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      }, 5000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info('MakeAnon is ready to accept connections');

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
