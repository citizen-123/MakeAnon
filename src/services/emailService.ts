import nodemailer from 'nodemailer';
import { ForwardResult, EmailMessage } from '../types';
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
 * Forward an email to the real recipient
 */
export async function forwardEmail(
  originalMessage: EmailMessage,
  realEmail: string,
  aliasAddress: string
): Promise<ForwardResult> {
  try {
    const transport = getTransporter();

    // Build the forwarded message
    const forwardedSubject = originalMessage.subject
      ? `[via ${aliasAddress}] ${originalMessage.subject}`
      : `[via ${aliasAddress}] (no subject)`;

    // Create header showing original sender
    const headerText = `
---------- Forwarded message ----------
From: ${originalMessage.from}
To: ${aliasAddress}
Subject: ${originalMessage.subject || '(no subject)'}
----------------------------------------

`;

    const mailOptions: nodemailer.SendMailOptions = {
      from: process.env.SMTP_OUTBOUND_USER,
      to: realEmail,
      subject: forwardedSubject,
      text: headerText + (originalMessage.text || ''),
      html: originalMessage.html
        ? `<div style="border-left: 3px solid #ccc; padding-left: 10px; margin-bottom: 20px; color: #666;">
            <p><strong>Forwarded via:</strong> ${aliasAddress}</p>
            <p><strong>From:</strong> ${originalMessage.from}</p>
            <p><strong>Subject:</strong> ${originalMessage.subject || '(no subject)'}</p>
           </div>
           <hr/>
           ${originalMessage.html}`
        : undefined,
      replyTo: originalMessage.from,
      headers: {
        'X-Emask-Forwarded': 'true',
        'X-Emask-Original-From': originalMessage.from,
        'X-Emask-Alias': aliasAddress,
      },
    };

    const result = await transport.sendMail(mailOptions);

    logger.info(`Email forwarded successfully: ${aliasAddress} -> ${realEmail}`);

    return {
      success: true,
      messageId: result.messageId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to forward email: ${errorMessage}`);

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Send a notification email (e.g., for alias activity)
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
      from: process.env.SMTP_OUTBOUND_USER,
      to,
      subject: `[Emask] ${subject}`,
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

export default {
  verifyConnection,
  forwardEmail,
  sendNotification,
};
