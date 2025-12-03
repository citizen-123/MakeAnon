import { SMTPServer, SMTPServerDataStream, SMTPServerSession } from 'smtp-server';
import { simpleParser, ParsedMail } from 'mailparser';
import prisma from './database';
import { forwardEmail } from './emailService';
import { extractAliasFromEmail, parseEmailAddress } from '../utils/helpers';
import logger from '../utils/logger';

let smtpServer: SMTPServer | null = null;

/**
 * Process incoming email
 */
async function processEmail(
  session: SMTPServerSession,
  stream: SMTPServerDataStream
): Promise<void> {
  try {
    // Parse the email
    const parsed: ParsedMail = await simpleParser(stream);

    // Get recipient addresses
    const recipients = session.envelope.rcptTo.map((r) => r.address.toLowerCase());

    logger.info(`Received email from ${session.envelope.mailFrom} to ${recipients.join(', ')}`);

    for (const recipientAddress of recipients) {
      // Extract alias from email address
      const aliasPrefix = extractAliasFromEmail(recipientAddress);

      if (!aliasPrefix) {
        logger.warn(`Invalid alias format: ${recipientAddress}`);
        continue;
      }

      // Look up the alias
      const alias = await prisma.alias.findUnique({
        where: { alias: aliasPrefix },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              isActive: true,
            },
          },
        },
      });

      if (!alias) {
        logger.warn(`Alias not found: ${aliasPrefix}`);
        await logEmail(null, null, session.envelope.mailFrom?.address || 'unknown', recipientAddress, parsed.subject || null, 'failed', 'Alias not found');
        continue;
      }

      if (!alias.isActive) {
        logger.info(`Alias is inactive: ${alias.fullAddress}`);
        await logEmail(alias.id, alias.userId, session.envelope.mailFrom?.address || 'unknown', recipientAddress, parsed.subject || null, 'blocked', 'Alias is inactive');
        continue;
      }

      if (!alias.user.isActive) {
        logger.info(`User account is inactive for alias: ${alias.fullAddress}`);
        await logEmail(alias.id, alias.userId, session.envelope.mailFrom?.address || 'unknown', recipientAddress, parsed.subject || null, 'blocked', 'User account inactive');
        continue;
      }

      // Forward the email
      const fromAddress = session.envelope.mailFrom?.address || parseEmailAddress(parsed.from?.text || '').email;

      const result = await forwardEmail(
        {
          from: parsed.from?.text || fromAddress,
          to: [recipientAddress],
          subject: parsed.subject || undefined,
          text: parsed.text || undefined,
          html: parsed.html || undefined,
        },
        alias.user.email,
        alias.fullAddress
      );

      if (result.success) {
        // Update alias statistics
        await prisma.alias.update({
          where: { id: alias.id },
          data: {
            forwardCount: { increment: 1 },
            lastForwardAt: new Date(),
          },
        });

        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'forwarded');
        logger.info(`Email forwarded: ${alias.fullAddress} -> ${alias.user.email}`);
      } else {
        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'failed', result.error);
        logger.error(`Failed to forward email: ${result.error}`);
      }
    }
  } catch (error) {
    logger.error('Error processing email:', error);
    throw error;
  }
}

/**
 * Log email activity
 */
async function logEmail(
  aliasId: string | null,
  userId: string | null,
  fromEmail: string,
  toAlias: string,
  subject: string | null,
  status: string,
  error?: string
): Promise<void> {
  try {
    await prisma.emailLog.create({
      data: {
        aliasId,
        userId,
        fromEmail,
        toAlias,
        subject,
        status,
        error,
      },
    });
  } catch (err) {
    logger.error('Failed to log email:', err);
  }
}

/**
 * Create and start the SMTP server
 */
export function startSmtpServer(): SMTPServer {
  const port = parseInt(process.env.SMTP_PORT || '25');
  const host = process.env.SMTP_HOST || '0.0.0.0';

  smtpServer = new SMTPServer({
    // Disable authentication for incoming mail (we're receiving, not sending)
    authOptional: true,
    disabledCommands: ['AUTH'],

    // Accept emails for our domain
    onRcptTo(address, session, callback) {
      const alias = extractAliasFromEmail(address.address);
      if (!alias) {
        callback(new Error('Invalid recipient address'));
        return;
      }
      callback();
    },

    // Process the email data
    onData(stream, session, callback) {
      processEmail(session, stream)
        .then(() => callback())
        .catch((error) => {
          logger.error('SMTP data processing error:', error);
          callback(new Error('Failed to process email'));
        });
    },

    // Log connections
    onConnect(session, callback) {
      logger.debug(`SMTP connection from ${session.remoteAddress}`);
      callback();
    },

    // Log disconnections
    onClose(session) {
      logger.debug(`SMTP connection closed from ${session.remoteAddress}`);
    },

    // Error handling
    onError(error) {
      logger.error('SMTP server error:', error);
    },

    // Banner
    banner: 'Emask Email Forwarding Service',
  });

  smtpServer.listen(port, host, () => {
    logger.info(`SMTP server listening on ${host}:${port}`);
  });

  smtpServer.on('error', (error) => {
    logger.error('SMTP server error:', error);
  });

  return smtpServer;
}

/**
 * Stop the SMTP server
 */
export function stopSmtpServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!smtpServer) {
      resolve();
      return;
    }

    smtpServer.close((error) => {
      if (error) {
        reject(error);
      } else {
        logger.info('SMTP server stopped');
        resolve();
      }
    });
  });
}

export default {
  startSmtpServer,
  stopSmtpServer,
};
