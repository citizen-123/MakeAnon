import prisma from './database';
import { sendNotification } from './emailService';
import {
  generateSecureToken,
  createVerificationUrl,
  calculateExpiresAt,
} from '../utils/helpers';
import logger from '../utils/logger';

const TOKEN_EXPIRY_HOURS = parseInt(process.env.VERIFICATION_TOKEN_EXPIRY_HOURS || '24');

export interface CreateVerificationTokenResult {
  success: boolean;
  token?: string;
  expiresAt?: Date;
  error?: string;
}

/**
 * Create a verification token for an email address
 */
export async function createVerificationToken(
  email: string,
  type: 'email_verify' | 'alias_verify' | 'password_reset' | 'management',
  metadata?: Record<string, unknown>
): Promise<CreateVerificationTokenResult> {
  try {
    // Check for existing unexpired token
    const existing = await prisma.verificationToken.findFirst({
      where: {
        email: email.toLowerCase(),
        type,
        expiresAt: { gt: new Date() },
        usedAt: null,
      },
    });

    // Rate limit: don't create new token if one was created recently
    if (existing) {
      const cooldown = parseInt(process.env.VERIFICATION_RESEND_COOLDOWN || '60') * 1000;
      const timeSinceCreated = Date.now() - existing.createdAt.getTime();

      if (timeSinceCreated < cooldown) {
        return {
          success: false,
          error: `Please wait ${Math.ceil((cooldown - timeSinceCreated) / 1000)} seconds before requesting another verification email`,
        };
      }
    }

    // Generate new token
    const token = generateSecureToken();
    const expiresAt = calculateExpiresAt(TOKEN_EXPIRY_HOURS / 24);

    await prisma.verificationToken.create({
      data: {
        email: email.toLowerCase(),
        token,
        type,
        metadata: metadata ? JSON.stringify(metadata) : null,
        expiresAt,
      },
    });

    return { success: true, token, expiresAt };
  } catch (error) {
    logger.error('Failed to create verification token:', error);
    return { success: false, error: 'Failed to create verification token' };
  }
}

/**
 * Verify a token and mark it as used
 */
export async function verifyToken(
  token: string,
  expectedType?: string
): Promise<{
  success: boolean;
  email?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const verification = await prisma.verificationToken.findUnique({
      where: { token },
    });

    if (!verification) {
      return { success: false, error: 'Invalid verification token' };
    }

    if (verification.usedAt) {
      return { success: false, error: 'This verification link has already been used' };
    }

    if (verification.expiresAt < new Date()) {
      return { success: false, error: 'This verification link has expired' };
    }

    if (expectedType && verification.type !== expectedType) {
      return { success: false, error: 'Invalid token type' };
    }

    // Mark token as used
    await prisma.verificationToken.update({
      where: { id: verification.id },
      data: { usedAt: new Date() },
    });

    return {
      success: true,
      email: verification.email,
      type: verification.type,
      metadata: verification.metadata ? JSON.parse(verification.metadata) : undefined,
    };
  } catch (error) {
    logger.error('Failed to verify token:', error);
    return { success: false, error: 'Verification failed' };
  }
}

/**
 * Send verification email for a new alias
 */
export async function sendAliasVerificationEmail(
  destinationEmail: string,
  aliasAddress: string,
  managementToken: string
): Promise<boolean> {
  const tokenResult = await createVerificationToken(
    destinationEmail,
    'alias_verify',
    { aliasAddress, managementToken }
  );

  if (!tokenResult.success || !tokenResult.token) {
    logger.error('Failed to create alias verification token');
    return false;
  }

  const verificationUrl = createVerificationUrl(tokenResult.token);

  const subject = `Verify your email alias: ${aliasAddress}`;
  const text = `
Hello,

You (or someone) created an email alias that forwards to this address:

Alias: ${aliasAddress}
Forwards to: ${destinationEmail}

To activate this alias, please verify your email by clicking the link below:

${verificationUrl}

This link will expire in ${TOKEN_EXPIRY_HOURS} hours.

If you did not create this alias, you can safely ignore this email.

--
Emask - Email Masking Service
`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; }
    .alias-box { background: white; padding: 15px; border-radius: 8px; margin: 15px 0; border: 1px solid #e5e7eb; }
    .button { display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Verify Your Email Alias</h1>
    </div>
    <div class="content">
      <p>Hello,</p>
      <p>You (or someone) created an email alias that forwards to this address:</p>

      <div class="alias-box">
        <p><strong>Alias:</strong> ${aliasAddress}</p>
        <p><strong>Forwards to:</strong> ${destinationEmail}</p>
      </div>

      <p>To activate this alias, please verify your email:</p>

      <p style="text-align: center;">
        <a href="${verificationUrl}" class="button">Verify Email</a>
      </p>

      <p style="font-size: 14px; color: #6b7280;">
        This link will expire in ${TOKEN_EXPIRY_HOURS} hours.<br>
        If you did not create this alias, you can safely ignore this email.
      </p>
    </div>
    <div class="footer">
      <p>Emask - Email Masking Service</p>
    </div>
  </div>
</body>
</html>
`;

  const result = await sendNotification(destinationEmail, subject, text, html);
  return result.success;
}

/**
 * Send management link for an alias
 */
export async function sendManagementLinkEmail(
  destinationEmail: string,
  aliasAddress: string,
  managementUrl: string
): Promise<boolean> {
  const subject = `Your alias management link: ${aliasAddress}`;
  const text = `
Hello,

Here is your management link for the email alias:

Alias: ${aliasAddress}
Forwards to: ${destinationEmail}

Management Link: ${managementUrl}

With this link you can:
- Enable or disable the alias
- View forwarding statistics
- Block specific senders
- Delete the alias

Keep this link safe - anyone with this link can manage this alias.

--
Emask - Email Masking Service
`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; }
    .alias-box { background: white; padding: 15px; border-radius: 8px; margin: 15px 0; border: 1px solid #e5e7eb; }
    .button { display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
    .warning { background: #fef3c7; padding: 10px; border-radius: 6px; margin: 15px 0; color: #92400e; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Your Alias Management Link</h1>
    </div>
    <div class="content">
      <p>Hello,</p>
      <p>Here is your management link for the email alias:</p>

      <div class="alias-box">
        <p><strong>Alias:</strong> ${aliasAddress}</p>
        <p><strong>Forwards to:</strong> ${destinationEmail}</p>
      </div>

      <p style="text-align: center;">
        <a href="${managementUrl}" class="button">Manage Alias</a>
      </p>

      <p>With this link you can:</p>
      <ul>
        <li>Enable or disable the alias</li>
        <li>View forwarding statistics</li>
        <li>Block specific senders</li>
        <li>Delete the alias</li>
      </ul>

      <div class="warning">
        <strong>Keep this link safe!</strong> Anyone with this link can manage this alias.
      </div>
    </div>
    <div class="footer">
      <p>Emask - Email Masking Service</p>
    </div>
  </div>
</body>
</html>
`;

  const result = await sendNotification(destinationEmail, subject, text, html);
  return result.success;
}

/**
 * Clean up expired tokens
 */
export async function cleanupExpiredTokens(): Promise<number> {
  try {
    const result = await prisma.verificationToken.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    return result.count;
  } catch (error) {
    logger.error('Failed to cleanup expired tokens:', error);
    return 0;
  }
}

export default {
  createVerificationToken,
  verifyToken,
  sendAliasVerificationEmail,
  sendManagementLinkEmail,
  cleanupExpiredTokens,
};
