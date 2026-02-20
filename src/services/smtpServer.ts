import { SMTPServer, SMTPServerDataStream, SMTPServerSession, SMTPServerAddress } from 'smtp-server';
import { simpleParser, ParsedMail } from 'mailparser';
import prisma from './database';
import { forwardEmail, sendReplyEmail } from './emailService';
import { checkRateLimit, getCachedAlias, cacheAlias } from './redis';
import { parseAliasEmail, parseEmailAddress, isReplyAddress, getEmailDomains } from '../utils/helpers';
import { decryptEmail, EncryptedData } from '../utils/encryption';
import logger from '../utils/logger';

let smtpServer: SMTPServer | null = null;

const MAX_EMAIL_SIZE = parseInt(process.env.MAX_EMAIL_SIZE_BYTES || '26214400'); // 25MB

/**
 * Mask an email address for privacy-safe storage (e.g., john.doe@gmail.com → j*******e@gmail.com)
 */
function maskEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex < 1) return '***';
  const local = email.substring(0, atIndex);
  const domain = email.substring(atIndex);
  if (local.length <= 2) return `${local[0]}*${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 5))}${local[local.length - 1]}${domain}`;
}
const FORWARD_LIMIT_PER_MINUTE = parseInt(process.env.FORWARD_LIMIT_PER_MINUTE || '30');
const MIN_PROCESSING_MS = parseInt(process.env.MIN_PROCESSING_MS || '100');

// Log level configuration: NONE, PRIVATE, PUBLIC, ALL
type LogLevel = 'NONE' | 'PRIVATE' | 'PUBLIC' | 'ALL';
const LOG_LEVEL: LogLevel = (process.env.LOG?.toUpperCase() as LogLevel) || 'ALL';

/**
 * Check if logging is enabled for the given alias privacy level
 */
function shouldLog(isPrivate: boolean | null): boolean {
  switch (LOG_LEVEL) {
    case 'NONE':
      return false;
    case 'PRIVATE':
      return isPrivate === true;
    case 'PUBLIC':
      return isPrivate === false || isPrivate === null;
    case 'ALL':
    default:
      return true;
  }
}

interface AliasWithUser {
  id: string;
  alias: string;
  fullAddress: string;
  destinationEmail: string;
  destinationIv: string | null;
  destinationSalt: string | null;
  destinationAuthTag: string | null;
  isEncrypted: boolean;
  emailVerified: boolean;
  isActive: boolean;
  isPrivate: boolean;
  replyEnabled: boolean;
  replyPrefix: string | null;
  userId: string | null;
  domainId: string;
  blockedSenders: { email: string; isPattern: boolean }[];
}

/**
 * Decrypt alias destination email if encrypted
 */
function getDestinationEmail(alias: AliasWithUser): string {
  if (alias.isEncrypted && alias.destinationIv && alias.destinationSalt && alias.destinationAuthTag) {
    const encryptedData: EncryptedData = {
      ciphertext: alias.destinationEmail,
      iv: alias.destinationIv,
      salt: alias.destinationSalt,
      authTag: alias.destinationAuthTag,
    };
    return decryptEmail(encryptedData, alias.id);
  }
  // Legacy unencrypted email
  return alias.destinationEmail;
}

/**
 * Look up alias with caching
 */
async function lookupAlias(aliasName: string, domainName: string): Promise<AliasWithUser | null> {
  const cacheKey = `${aliasName}@${domainName}`;

  // Try cache first
  const cached = await getCachedAlias<AliasWithUser>(cacheKey);
  if (cached) return cached;

  // Look up in database
  const alias = await prisma.alias.findFirst({
    where: {
      alias: aliasName,
      domain: { domain: domainName },
    },
    select: {
      id: true,
      alias: true,
      fullAddress: true,
      destinationEmail: true,
      destinationIv: true,
      destinationSalt: true,
      destinationAuthTag: true,
      isEncrypted: true,
      emailVerified: true,
      isActive: true,
      isPrivate: true,
      replyEnabled: true,
      replyPrefix: true,
      userId: true,
      domainId: true,
      blockedSenders: {
        select: { email: true, isPattern: true },
      },
    },
  });

  if (alias) {
    await cacheAlias(cacheKey, alias);
  }

  return alias;
}

/**
 * Look up alias by reply prefix
 */
async function lookupAliasByReplyPrefix(replyPrefix: string): Promise<AliasWithUser | null> {
  const alias = await prisma.alias.findFirst({
    where: { replyPrefix },
    select: {
      id: true,
      alias: true,
      fullAddress: true,
      destinationEmail: true,
      destinationIv: true,
      destinationSalt: true,
      destinationAuthTag: true,
      isEncrypted: true,
      emailVerified: true,
      isActive: true,
      isPrivate: true,
      replyEnabled: true,
      replyPrefix: true,
      userId: true,
      domainId: true,
      blockedSenders: {
        select: { email: true, isPattern: true },
      },
    },
  });

  return alias;
}

/**
 * Convert a glob pattern (with * and ?) to a safe regex.
 * Only allows * (any chars) and ? (single char) as wildcards.
 * All other characters are escaped to prevent ReDoS.
 */
function globToSafeRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('')
    .map(char => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Check if sender is blocked
 */
function isSenderBlocked(
  senderEmail: string,
  blockedSenders: { email: string; isPattern: boolean }[]
): boolean {
  const sender = senderEmail.toLowerCase();

  for (const blocked of blockedSenders) {
    if (blocked.isPattern) {
      const regex = globToSafeRegex(blocked.email);
      if (regex.test(sender)) return true;
    } else if (blocked.email.toLowerCase() === sender) {
      return true;
    }
  }

  return false;
}

/**
 * Process incoming email
 */
async function processEmail(
  session: SMTPServerSession,
  stream: SMTPServerDataStream
): Promise<void> {
  const startTime = Date.now();

  try {
    // Parse the email
    const parsed: ParsedMail = await simpleParser(stream);

    // Get recipient addresses
    const recipients = session.envelope.rcptTo.map((r: SMTPServerAddress) => r.address.toLowerCase());
    const mailFrom = session.envelope.mailFrom;
    const fromAddress = (mailFrom && typeof mailFrom !== 'boolean' ? mailFrom.address : null) || parseEmailAddress(parsed.from?.text || '').email;

    logger.info(`Received email from ${maskEmail(fromAddress)} to ${recipients.join(', ')}`);

    for (const recipientAddress of recipients) {
      // Parse the recipient address
      const parsedRecipient = parseAliasEmail(recipientAddress);

      if (!parsedRecipient) {
        logger.warn(`Invalid alias format: ${recipientAddress}`);
        continue;
      }

      const { alias: aliasName, domain: domainName } = parsedRecipient;

      // Check if this is a reply address
      if (isReplyAddress(recipientAddress)) {
        await handleReply(aliasName, parsed, fromAddress, recipientAddress, startTime);
        continue;
      }

      // Look up the alias
      const alias = await lookupAlias(aliasName, domainName);

      if (!alias) {
        logger.warn(`Alias not found: ${aliasName}@${domainName}`);
        await logEmail(null, null, fromAddress, recipientAddress, parsed.subject || null, 'failed', null, 'Alias not found', Date.now() - startTime);
        continue;
      }

      // Check if alias is active
      if (!alias.isActive) {
        logger.info(`Alias is inactive: ${alias.fullAddress}`);
        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'blocked', alias.isPrivate, 'Alias is inactive', Date.now() - startTime);
        continue;
      }

      // Check if sender is blocked
      if (isSenderBlocked(fromAddress, alias.blockedSenders)) {
        logger.info(`Sender blocked for ${alias.fullAddress}: ${maskEmail(fromAddress)}`);
        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'blocked', alias.isPrivate, 'Sender is blocked', Date.now() - startTime);

        // Update blocked count
        await prisma.alias.update({
          where: { id: alias.id },
          data: { blockedCount: { increment: 1 } },
        });

        continue;
      }

      // Rate limiting
      const rateLimit = await checkRateLimit(`forward:${alias.id}`, FORWARD_LIMIT_PER_MINUTE, 60);
      if (!rateLimit.allowed) {
        logger.warn(`Rate limit exceeded for alias: ${alias.fullAddress}`);
        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'blocked', alias.isPrivate, 'Rate limit exceeded', Date.now() - startTime);
        continue;
      }

      // Decrypt destination email for forwarding
      const destinationEmail = getDestinationEmail(alias);

      // Forward the email
      const result = await forwardEmail(
        {
          from: parsed.from?.text || fromAddress,
          to: [recipientAddress],
          subject: parsed.subject || undefined,
          text: parsed.text || undefined,
          html: parsed.html || undefined,
          messageId: parsed.messageId,
        },
        destinationEmail,
        alias.fullAddress,
        alias.replyEnabled ? alias.replyPrefix : null
      );

      const processingTime = Date.now() - startTime;

      if (result.success) {
        // Update alias statistics
        await prisma.alias.update({
          where: { id: alias.id },
          data: {
            forwardCount: { increment: 1 },
            lastForwardAt: new Date(),
          },
        });

        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'forwarded', alias.isPrivate, undefined, processingTime, result.messageId);

        // Log without exposing the real email
        logger.info(`Email forwarded: ${alias.fullAddress} -> [encrypted] (${processingTime}ms)`);
      } else {
        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'failed', alias.isPrivate, result.error, processingTime);

        logger.error(`Failed to forward email: ${result.error}`);
      }
    }
  } catch (error) {
    logger.error('Error processing email:', error);
    throw error;
  } finally {
    // Enforce minimum processing time to prevent timing-based alias enumeration
    const elapsed = Date.now() - startTime;
    if (elapsed < MIN_PROCESSING_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_PROCESSING_MS - elapsed));
    }
  }
}

/**
 * Handle reply emails (sent through alias)
 */
async function handleReply(
  replyPrefix: string,
  parsed: ParsedMail,
  fromAddress: string,
  recipientAddress: string,
  startTime: number
): Promise<void> {
  // Look up alias by reply prefix
  const alias = await lookupAliasByReplyPrefix(replyPrefix);

  if (!alias) {
    logger.warn(`Reply alias not found: ${replyPrefix}`);
    await logEmail(null, null, fromAddress, recipientAddress, parsed.subject || null, 'failed', null, 'Reply alias not found', Date.now() - startTime);
    return;
  }

  if (!alias.replyEnabled) {
    logger.info(`Reply not enabled for alias: ${alias.fullAddress}`);
    await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'blocked', alias.isPrivate, 'Reply not enabled', Date.now() - startTime);
    return;
  }

  // Verify the sender is the alias owner (decrypt to check)
  const destinationEmail = getDestinationEmail(alias);
  if (fromAddress.toLowerCase() !== destinationEmail.toLowerCase()) {
    logger.warn(`Reply sender mismatch for alias: ${alias.fullAddress}`);
    await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'blocked', alias.isPrivate, 'Reply sender mismatch', Date.now() - startTime);
    return;
  }

  // Get the original recipient from In-Reply-To or References header
  // This requires storing the original sender, which we'd need to track
  // For now, we'll extract from the subject line or fail gracefully

  // TODO: Implement full reply tracking
  logger.info(`Reply handling not fully implemented yet for: ${alias.fullAddress}`);
  await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'failed', alias.isPrivate, 'Reply handling not fully implemented', Date.now() - startTime);
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
  isPrivate: boolean | null,
  error?: string,
  processingTime?: number,
  messageId?: string
): Promise<void> {
  // Check if logging is enabled for this alias type
  if (!shouldLog(isPrivate)) {
    logger.debug(`Logging disabled for ${isPrivate ? 'private' : 'public'} alias (LOG=${LOG_LEVEL})`);
    return;
  }

  try {
    await prisma.emailLog.create({
      data: {
        aliasId,
        userId,
        fromEmail: maskEmail(fromEmail),
        toAlias,
        subject: null, // Subject not stored for privacy
        status,
        error,
        processingTime,
        messageId,
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
  const domains = getEmailDomains();

  smtpServer = new SMTPServer({
    // Disable authentication for incoming mail
    authOptional: true,
    disabledCommands: ['AUTH'],

    // Size limit
    size: MAX_EMAIL_SIZE,

    // Accept emails for our domains
    onRcptTo(address, session, callback) {
      const parsed = parseAliasEmail(address.address);
      if (!parsed) {
        logger.debug(`Rejected: invalid recipient ${address.address}`);
        callback(new Error('Invalid recipient address'));
        return;
      }

      if (!domains.includes(parsed.domain)) {
        logger.debug(`Rejected: unknown domain ${parsed.domain}`);
        callback(new Error('Unknown domain'));
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
      logger.debug('SMTP connection opened');
      callback();
    },

    // Log disconnections
    onClose(session) {
      logger.debug('SMTP connection closed');
    },

    // Banner
    banner: 'ESMTP',
  });

  smtpServer.listen(port, host, () => {
    logger.info(`SMTP server listening on ${host}:${port}`);
    logger.info(`Accepting mail for domains: ${domains.join(', ')}`);
  });

  smtpServer.on('error', (error: Error) => {
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

    smtpServer.close(() => {
      logger.info('SMTP server stopped');
      resolve();
    });
  });
}

export default {
  startSmtpServer,
  stopSmtpServer,
};
