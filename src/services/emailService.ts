import nodemailer from 'nodemailer';
import { ForwardResult, EmailMessage } from '../types';
import { getDefaultDomain, createFullAliasEmail } from '../utils/helpers';
import logger from '../utils/logger';

// Create reusable transporter
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_OUTBOUND_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_OUTBOUND_PORT || '587'),
    secure: process.env.SMTP_OUTBOUND_SECURE === 'true',
    auth: {
      user: process.env.SMTP_OUTBOUND_USER,
      pass: process.env.SMTP_OUTBOUND_PASS,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });
};

let transporter: nodemailer.Transporter | null = null;

/**
 * Get or create the email transporter
 */
function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
}

/**
 * Verify the SMTP connection
 */
export async function verifyConnection(): Promise<boolean> {
  try {
    const transport = getTransporter();
    await transport.verify();
    logger.info('SMTP connection verified successfully');
    return true;
  } catch (error) {
    logger.error('SMTP connection verification failed:', error);
    return false;
  }
}

/**
 * Get the from address for outbound emails
 */
function getFromAddress(): string {
  const fromAddress = process.env.SMTP_FROM_ADDRESS || process.env.SMTP_OUTBOUND_USER;
  const fromName = process.env.SMTP_FROM_NAME || 'Emask';
  return `"${fromName}" <${fromAddress}>`;
}

/**
 * Forward an email to the real recipient
 */
export async function forwardEmail(
  originalMessage: EmailMessage,
  realEmail: string,
  aliasAddress: string,
  replyPrefix?: string | null
): Promise<ForwardResult> {
  const startTime = Date.now();

  try {
    const transport = getTransporter();

    // Build the forwarded message
    const forwardedSubject = originalMessage.subject
      ? `[via ${aliasAddress}] ${originalMessage.subject}`
      : `[via ${aliasAddress}] (no subject)`;

    // Create reply-to address if reply is enabled
    let replyToAddress = originalMessage.from;
    if (replyPrefix) {
      const domain = aliasAddress.split('@')[1];
      replyToAddress = `${replyPrefix}@${domain}`;
    }

    // Create header showing original sender
    const headerText = `
---------- Forwarded via Emask ----------
From: ${originalMessage.from}
To: ${aliasAddress}
Subject: ${originalMessage.subject || '(no subject)'}
------------------------------------------

`;

    const headerHtml = `
<div style="background: #f8f9fa; border-left: 4px solid #4F46E5; padding: 12px 16px; margin-bottom: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; color: #374151;">
  <div style="font-weight: 600; color: #4F46E5; margin-bottom: 8px;">Forwarded via Emask</div>
  <div><strong>From:</strong> ${escapeHtml(originalMessage.from)}</div>
  <div><strong>To:</strong> ${escapeHtml(aliasAddress)}</div>
  <div><strong>Subject:</strong> ${escapeHtml(originalMessage.subject || '(no subject)')}</div>
</div>
<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;"/>
`;

    const mailOptions: nodemailer.SendMailOptions = {
      from: getFromAddress(),
      to: realEmail,
      subject: forwardedSubject,
      text: headerText + (originalMessage.text || ''),
      html: originalMessage.html
        ? headerHtml + originalMessage.html
        : undefined,
      replyTo: replyToAddress,
      headers: {
        'X-Emask-Forwarded': 'true',
        'X-Emask-Original-From': originalMessage.from,
        'X-Emask-Alias': aliasAddress,
        ...(originalMessage.messageId && { 'X-Emask-Original-Message-Id': originalMessage.messageId }),
        ...(replyPrefix && { 'X-Emask-Reply-Prefix': replyPrefix }),
      },
    };

    const result = await transport.sendMail(mailOptions);
    const processingTime = Date.now() - startTime;

    logger.info(`Email forwarded successfully: ${aliasAddress} -> ${realEmail} (${processingTime}ms)`);

    return {
      success: true,
      messageId: result.messageId,
      processingTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to forward email: ${errorMessage}`);

    return {
      success: false,
      error: errorMessage,
      processingTime: Date.now() - startTime,
    };
  }
}

/**
 * Send a reply email through an alias
 */
export async function sendReplyEmail(
  originalSender: string,
  aliasAddress: string,
  subject: string,
  text?: string,
  html?: string
): Promise<ForwardResult> {
  try {
    const transport = getTransporter();

    // Send from the alias address to the original sender
    const mailOptions: nodemailer.SendMailOptions = {
      from: aliasAddress,
      to: originalSender,
      subject,
      text,
      html,
      headers: {
        'X-Emask-Reply': 'true',
        'X-Emask-Alias': aliasAddress,
      },
    };

    const result = await transport.sendMail(mailOptions);

    logger.info(`Reply sent: ${aliasAddress} -> ${originalSender}`);

    return {
      success: true,
      messageId: result.messageId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to send reply: ${errorMessage}`);

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Send a notification/system email
 */
export async function sendNotification(
  to: string,
  subject: string,
  text: string,
  html?: string
): Promise<ForwardResult> {
  try {
    const transport = getTransporter();

    const result = await transport.sendMail({
      from: getFromAddress(),
      to,
      subject,
      text,
      html,
    });

    return {
      success: true,
      messageId: result.messageId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to send notification: ${errorMessage}`);

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Escape HTML entities
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

export default {
  verifyConnection,
  forwardEmail,
  sendReplyEmail,
  sendNotification,
};
