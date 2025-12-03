import dotenv from 'dotenv';

// Load environment variables first
dotenv.config();

import app from './app';
import { startSmtpServer, stopSmtpServer } from './services/smtpServer';
import { verifyConnection } from './services/emailService';
import logger from './utils/logger';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  try {
    // Verify outbound SMTP connection (optional, don't fail if not configured)
    if (process.env.SMTP_OUTBOUND_USER && process.env.SMTP_OUTBOUND_PASS) {
      const smtpConnected = await verifyConnection();
      if (!smtpConnected) {
        logger.warn('Outbound SMTP connection could not be verified. Email forwarding may not work.');
      }
    } else {
      logger.warn('Outbound SMTP credentials not configured. Email forwarding will not work.');
    }

    // Start HTTP API server
    const server = app.listen(PORT, HOST, () => {
      logger.info(`Emask API server running on http://${HOST}:${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    // Start SMTP server for receiving emails
    const smtpEnabled = process.env.SMTP_ENABLED !== 'false';
    if (smtpEnabled) {
      try {
        startSmtpServer();
      } catch (error) {
        logger.error('Failed to start SMTP server:', error);
        logger.warn('SMTP server disabled. You can still use the API, but email forwarding won\'t work.');
      }
    } else {
      logger.info('SMTP server disabled by configuration');
    }

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received. Starting graceful shutdown...`);

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

      // Give existing connections time to complete
      setTimeout(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      }, 5000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
