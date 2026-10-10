import fs from 'fs';
import tls from 'tls';
import crypto from 'crypto';
import { SMTPServer, SMTPServerDataStream, SMTPServerSession, SMTPServerAddress } from 'smtp-server';
import { simpleParser, ParsedMail } from 'mailparser';
import prisma from './database';
import { forwardEmail, scrubEmailAddresses } from './emailService';
import { checkRateLimit, getCachedAlias, cacheAlias, isDeliveryRecorded, recordDelivery } from './redis';
import { parseAliasEmail, parseEmailAddress, isReplyAddress, getEmailDomains } from '../utils/helpers';
import { decryptEmail, EncryptedData } from '../utils/encryption';
import logger from '../utils/logger';

let smtpServer: SMTPServer | null = null;
let tlsReloadTimer: NodeJS.Timeout | null = null;

const MAX_EMAIL_SIZE = parseInt(process.env.MAX_EMAIL_SIZE_BYTES || '26214400'); // 25MB
const MAX_CLIENTS = parseInt(process.env.SMTP_MAX_CLIENTS || '50');
const SOCKET_TIMEOUT_MS = 60 * 1000;
const TLS_RELOAD_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Error carrying an explicit SMTP response code (smtp-server sends
 * `${responseCode} ${message}` to the client).
 */
export class SmtpResponseError extends Error {
  responseCode: number;

  constructor(responseCode: number, message: string) {
    super(message);
    this.name = 'SmtpResponseError';
    this.responseCode = responseCode;
  }
}

const tempForwardFailure = () =>
  new SmtpResponseError(451, '4.3.0 Temporary forwarding failure, try again later');

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
  expiresAt: Date | string | null; // string when read back from the JSON cache
  user: { isActive: boolean } | null;
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

const ALIAS_SELECT = {
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
  expiresAt: true,
  user: {
    select: { isActive: true },
  },
  blockedSenders: {
    select: { email: true, isPattern: true },
  },
} as const;

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
    select: ALIAS_SELECT,
  });

  if (alias) {
    await cacheAlias(cacheKey, alias);
  }

  return alias;
}

/**
 * Return why mail to this alias must not be forwarded, or null if it may be.
 */
export function getAliasBlockReason(alias: AliasWithUser, now: Date = new Date()): string | null {
  if (!alias.isActive) return 'Alias is inactive';
  if (!alias.emailVerified) return 'Alias is not verified';
  if (alias.expiresAt && new Date(alias.expiresAt).getTime() <= now.getTime()) {
    return 'Alias has expired';
  }
  if ((alias.isPrivate || alias.userId) && !alias.user?.isActive) {
    return 'Alias owner is inactive or missing';
  }
  return null;
}

/**
 * Case-insensitive wildcard match supporting * (any run of chars) and ? (one char).
 * Iterative two-pointer matcher that backtracks only to the most recent star,
 * so it runs in O(pattern * text) worst case with no exponential blow-up
 * (unlike a regex built from the pattern).
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase().replace(/\*+/g, '*');
  const t = text.toLowerCase();

  let pi = 0;
  let ti = 0;
  let starIdx = -1;
  let starMatch = 0;

  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || (p[pi] !== '*' && p[pi] === t[ti]))) {
      pi++;
      ti++;
    } else if (pi < p.length && p[pi] === '*') {
      starIdx = pi;
      starMatch = ti;
      pi++;
    } else if (starIdx !== -1) {
      // Let the last star absorb one more character and retry
      pi = starIdx + 1;
      starMatch++;
      ti = starMatch;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

/**
 * Check if any of the sender addresses (envelope MAIL FROM, From header) is blocked
 */
export function isSenderBlocked(
  senderEmails: string[],
  blockedSenders: { email: string; isPattern: boolean }[]
): boolean {
  for (const senderEmail of senderEmails) {
    const sender = senderEmail.toLowerCase();

    for (const blocked of blockedSenders) {
      if (blocked.isPattern) {
        if (wildcardMatch(blocked.email, sender)) return true;
      } else if (blocked.email.toLowerCase() === sender) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Read the message stream into memory, discarding data once the size limit
 * is exceeded (the stream is still drained so the SMTP session can respond).
 */
function readMessage(stream: SMTPServerDataStream): Promise<{ raw: Buffer; sizeExceeded: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;

    stream.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (stream.sizeExceeded || size > MAX_EMAIL_SIZE) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => {
      const sizeExceeded = exceeded || stream.sizeExceeded;
      resolve({ raw: sizeExceeded ? Buffer.alloc(0) : Buffer.concat(chunks), sizeExceeded });
    });
    stream.once('error', reject);
  });
}

/**
 * Process incoming email.
 * Resolves when the message may be acknowledged with 250; rejects with an
 * SmtpResponseError (451 temporary / 552 too large) otherwise.
 */
export async function processEmail(
  session: SMTPServerSession,
  stream: SMTPServerDataStream
): Promise<void> {
  const startTime = Date.now();

  try {
    const { raw, sizeExceeded } = await readMessage(stream);
    if (sizeExceeded) {
      logger.warn('Rejected message exceeding maximum size');
      throw new SmtpResponseError(552, '5.3.4 Message size exceeds fixed maximum message size');
    }

    // Parse the email
    const parsed: ParsedMail = await simpleParser(raw);

    // Get recipient addresses
    const recipients = session.envelope.rcptTo.map((r: SMTPServerAddress) => r.address.toLowerCase());
    const mailFrom = session.envelope.mailFrom;
    const envelopeFrom = (mailFrom && typeof mailFrom !== 'boolean' ? mailFrom.address : '') || '';
    const headerFromAddresses = (parsed.from?.value || [])
      .map((a) => a.address || '')
      .filter(Boolean);
    const fromAddress = envelopeFrom || headerFromAddresses[0] || parseEmailAddress(parsed.from?.text || '').email;
    const senderAddresses = Array.from(
      new Set([envelopeFrom, ...headerFromAddresses].filter(Boolean).map((a) => a.toLowerCase()))
    );

    // Identifies this exact message for retry de-duplication. The body hash is
    // included so a foreign message reusing a Message-ID cannot suppress delivery.
    const messageFingerprint = `${parsed.messageId || ''}\n${crypto.createHash('sha256').update(raw).digest('hex')}`;
    let forwardFailed = false;

    logger.info(`Received email from ${maskEmail(fromAddress)} to ${recipients.join(', ')}`);

    for (const recipientAddress of recipients) {
      // Parse the recipient address
      const parsedRecipient = parseAliasEmail(recipientAddress);

      if (!parsedRecipient) {
        logger.warn(`Invalid alias format: ${recipientAddress}`);
        continue;
      }

      const { alias: aliasName, domain: domainName } = parsedRecipient;

      // Reply addresses are rejected at RCPT TO; never forward them
      if (isReplyAddress(recipientAddress)) {
        continue;
      }

      // Look up the alias
      const alias = await lookupAlias(aliasName, domainName);

      if (!alias) {
        logger.warn(`Alias not found: ${aliasName}@${domainName}`);
        await logEmail(null, null, fromAddress, recipientAddress, parsed.subject || null, 'failed', null, 'Alias not found', Date.now() - startTime);
        continue;
      }

      // Check alias is active, verified, unexpired and has an active owner
      const blockReason = getAliasBlockReason(alias);
      if (blockReason) {
        logger.info(`Not forwarding to ${alias.fullAddress}: ${blockReason}`);
        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'blocked', alias.isPrivate, blockReason, Date.now() - startTime);
        continue;
      }

      // Check if sender (envelope or From header) is blocked
      if (isSenderBlocked(senderAddresses, alias.blockedSenders)) {
        logger.info(`Sender blocked for ${alias.fullAddress}: ${maskEmail(fromAddress)}`);
        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'blocked', alias.isPrivate, 'Sender is blocked', Date.now() - startTime);

        // Update blocked count
        await prisma.alias.update({
          where: { id: alias.id },
          data: { blockedCount: { increment: 1 } },
        });

        continue;
      }

      // Skip recipients already delivered on a previous attempt of this message
      const deliveryId = `${messageFingerprint}\n${recipientAddress}`;
      if (await isDeliveryRecorded(deliveryId)) {
        logger.info(`Skipping already-delivered retry for ${alias.fullAddress}`);
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
        await recordDelivery(deliveryId);

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
        forwardFailed = true;
        const safeError = scrubEmailAddresses(result.error || 'Unknown error');

        await logEmail(alias.id, alias.userId, fromAddress, recipientAddress, parsed.subject || null, 'failed', alias.isPrivate, safeError, processingTime);

        logger.error(`Failed to forward email for ${alias.fullAddress}: ${safeError}`);
      }
    }

    if (forwardFailed) {
      // Ask the sending MTA to retry; delivered recipients are skipped on retry
      throw tempForwardFailure();
    }
  } catch (error) {
    if (error instanceof SmtpResponseError) throw error;

    const message = scrubEmailAddresses(error instanceof Error ? error.message : String(error));
    logger.error(`Error processing email: ${message}`);
    throw new SmtpResponseError(451, '4.3.0 Temporary processing failure, try again later');
  } finally {
    // Enforce minimum processing time to prevent timing-based alias enumeration
    const elapsed = Date.now() - startTime;
    if (elapsed < MIN_PROCESSING_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_PROCESSING_MS - elapsed));
    }
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
        error: error ? scrubEmailAddresses(error) : error,
        processingTime,
        messageId,
      },
    });
  } catch (err) {
    logger.error('Failed to log email:', err);
  }
}

interface TlsCredentials {
  key: Buffer;
  cert: Buffer;
}

/**
 * Load the inbound STARTTLS key/cert from SMTP_TLS_KEY_PATH / SMTP_TLS_CERT_PATH.
 * Returns null (never throws) if unset, unreadable, or not a valid key/cert pair.
 */
export function loadTlsCredentials(): TlsCredentials | null {
  const keyPath = process.env.SMTP_TLS_KEY_PATH;
  const certPath = process.env.SMTP_TLS_CERT_PATH;
  if (!keyPath || !certPath) return null;

  try {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    // Validate the pair now so a bad file can never crash the server
    tls.createSecureContext({ key, cert });
    return { key, cert };
  } catch (error) {
    logger.warn(`Unable to load SMTP TLS certificate: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Re-read the TLS files and update the server's secure context if they changed.
 * Returns the credentials now in use.
 */
export function refreshTlsCredentials(
  server: Pick<SMTPServer, 'updateSecureContext'>,
  current: TlsCredentials | null
): TlsCredentials | null {
  const next = loadTlsCredentials();
  if (!next) return current;
  if (current && current.key.equals(next.key) && current.cert.equals(next.cert)) return current;

  try {
    server.updateSecureContext({ key: next.key, cert: next.cert });
    logger.info('SMTP TLS certificate reloaded');
    return next;
  } catch (error) {
    logger.warn(`Failed to update SMTP TLS context: ${error instanceof Error ? error.message : String(error)}`);
    return current;
  }
}

/**
 * Create and start the SMTP server
 */
export function startSmtpServer(): SMTPServer {
  const port = parseInt(process.env.SMTP_PORT || '25');
  const host = process.env.SMTP_HOST || '0.0.0.0';
  const domains = getEmailDomains();

  let tlsCredentials = loadTlsCredentials();
  if (!tlsCredentials) {
    logger.warn('SMTP_TLS_KEY_PATH/SMTP_TLS_CERT_PATH not set or unreadable - STARTTLS will use the built-in self-signed certificate');
  }

  smtpServer = new SMTPServer({
    // Disable authentication for incoming mail
    authOptional: true,
    disabledCommands: ['AUTH'],

    // STARTTLS certificate (falls back to smtp-server's built-in cert)
    ...(tlsCredentials && { key: tlsCredentials.key, cert: tlsCredentials.cert }),

    // Size and resource limits
    size: MAX_EMAIL_SIZE,
    maxClients: MAX_CLIENTS,
    socketTimeout: SOCKET_TIMEOUT_MS,

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

      if (isReplyAddress(address.address)) {
        logger.debug('Rejected: reply address');
        callback(new SmtpResponseError(550, '5.7.1 Replies are not supported'));
        return;
      }

      callback();
    },

    // Process the email data
    onData(stream, session, callback) {
      processEmail(session, stream)
        .then(() => callback())
        .catch((error) => {
          // processEmail already logged; always answer with an explicit code
          callback(
            error instanceof SmtpResponseError
              ? error
              : new SmtpResponseError(451, '4.3.0 Temporary processing failure, try again later')
          );
        });
    },

    // Log connections
    onConnect(session, callback) {
      logger.debug('SMTP connection opened');
      callback();
    },

    // Log disconnections
    onClose(_session) {
      logger.debug('SMTP connection closed');
    },

    // Banner
    banner: 'ESMTP',
  });

  // Periodically pick up renewed certificates
  if (process.env.SMTP_TLS_KEY_PATH && process.env.SMTP_TLS_CERT_PATH) {
    const server = smtpServer;
    tlsReloadTimer = setInterval(() => {
      tlsCredentials = refreshTlsCredentials(server, tlsCredentials);
    }, TLS_RELOAD_INTERVAL_MS);
    tlsReloadTimer.unref();
  }

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
  if (tlsReloadTimer) {
    clearInterval(tlsReloadTimer);
    tlsReloadTimer = null;
  }

  return new Promise((resolve) => {
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
