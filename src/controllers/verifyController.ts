import { Request, Response } from 'express';
import prisma from '../services/database';
import {
  verifyToken,
  sendManagementLinkEmail,
  sendAliasVerificationEmail,
} from '../services/verificationService';
import { invalidateAliasCache } from '../services/redis';
import { createManagementUrl, isValidEmail } from '../utils/helpers';
import { hashEmail, decryptEmail, EncryptedData } from '../utils/encryption';
import logger from '../utils/logger';

const RESEND_VERIFICATION_MESSAGE =
  'If a matching unverified alias exists, a verification email has been sent.';
const RESEND_MANAGEMENT_MESSAGE =
  'If the alias exists, a management link has been sent to the destination email.';

/**
 * Decrypt an alias's destination address (destinationEmail holds ciphertext
 * for encrypted rows; legacy rows hold plaintext).
 */
function getDestinationEmail(alias: {
  id: string;
  destinationEmail: string;
  destinationIv: string | null;
  destinationSalt: string | null;
  destinationAuthTag: string | null;
  isEncrypted: boolean;
}): string {
  if (alias.isEncrypted && alias.destinationIv && alias.destinationSalt && alias.destinationAuthTag) {
    const encryptedData: EncryptedData = {
      ciphertext: alias.destinationEmail,
      iv: alias.destinationIv,
      salt: alias.destinationSalt,
      authTag: alias.destinationAuthTag,
    };
    return decryptEmail(encryptedData, alias.id);
  }
  return alias.destinationEmail;
}

function isNonEmptyString(value: unknown, maxLength = 320): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * Verify an alias email address
 */
export async function verifyAliasEmail(req: Request, res: Response): Promise<void> {
  try {
    const token = req.params.token as string;

    const result = await verifyToken(token, 'alias_verify');

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
      });
      return;
    }

    const metadata = (result.metadata || {}) as { aliasId?: unknown };

    if (typeof metadata.aliasId !== 'string') {
      // Legacy token format (pre-hashing) or malformed metadata
      res.status(400).json({
        success: false,
        error: 'This verification link is no longer valid. Please request a new one.',
      });
      return;
    }

    const alias = await prisma.alias.findUnique({
      where: { id: metadata.aliasId },
    });

    // The token must have been issued for this alias's current destination
    if (!alias || !result.email || alias.destinationHash !== result.email) {
      res.status(404).json({
        success: false,
        error: 'Alias not found',
      });
      return;
    }

    // Verify and activate the alias
    await prisma.alias.update({
      where: { id: alias.id },
      data: {
        emailVerified: true,
        isActive: true,
        disabledAt: null,
      },
    });

    await invalidateAliasCache(alias.fullAddress);

    logger.info(`Alias verified: ${alias.fullAddress}`);

    const baseUrl = process.env.BASE_URL || '';

    // Private aliases are managed from the account dashboard (no management token)
    if (!alias.managementToken) {
      if (baseUrl) {
        res.redirect(`${baseUrl}/?verified=true`);
      } else {
        res.json({
          success: true,
          message: 'Email verified successfully! Your alias is now active.',
          data: { alias: alias.fullAddress },
        });
      }
      return;
    }

    // Send management link to the (decrypted) destination
    const managementUrl = createManagementUrl(alias.managementToken);
    try {
      await sendManagementLinkEmail(getDestinationEmail(alias), alias.fullAddress, managementUrl);
    } catch (error) {
      logger.error('Failed to send management link after verification:', error);
    }

    // Redirect to management page with token pre-filled
    if (baseUrl) {
      res.redirect(`${baseUrl}/#manage?token=${encodeURIComponent(alias.managementToken)}&verified=true`);
    } else {
      res.json({
        success: true,
        message: 'Email verified successfully! Your alias is now active.',
        data: {
          alias: alias.fullAddress,
          managementUrl,
        },
      });
    }
  } catch (error) {
    logger.error('Verify alias email error:', error);
    res.status(500).json({
      success: false,
      error: 'Verification failed',
    });
  }
}

/**
 * Resend verification email.
 * Always responds with the same 200 body (after input validation) so callers
 * can't learn whether an alias exists or whether sending succeeded.
 */
export async function resendVerification(req: Request, res: Response): Promise<void> {
  const { aliasId, email } = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  if (
    (aliasId !== undefined && !isNonEmptyString(aliasId, 64)) ||
    (email !== undefined && !isValidEmail(email))
  ) {
    res.status(400).json({
      success: false,
      error: 'Invalid alias ID or email',
    });
    return;
  }

  if (!aliasId && !email) {
    res.status(400).json({
      success: false,
      error: 'Please provide alias ID or email',
    });
    return;
  }

  try {
    // Find unverified alias
    const alias = await prisma.alias.findFirst({
      where: {
        ...(typeof aliasId === 'string' && { id: aliasId }),
        ...(typeof email === 'string' && { destinationHash: hashEmail(email.toLowerCase()) }),
        emailVerified: false,
      },
    });

    if (alias) {
      const sent = await sendAliasVerificationEmail(
        getDestinationEmail(alias),
        alias.fullAddress,
        alias.id
      );
      if (!sent) {
        logger.warn(`Verification email not sent for ${alias.fullAddress}`);
      }
    }
  } catch (error) {
    logger.error('Resend verification error:', error);
  }

  res.json({
    success: true,
    message: RESEND_VERIFICATION_MESSAGE,
  });
}

/**
 * Request management link to be resent
 */
export async function resendManagementLink(req: Request, res: Response): Promise<void> {
  try {
    const { aliasAddress, destinationEmail } = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    if (!isNonEmptyString(aliasAddress, 320) || !isValidEmail(destinationEmail)) {
      res.status(400).json({
        success: false,
        error: 'Please provide both alias address and destination email',
      });
      return;
    }

    // Find the alias
    const alias = await prisma.alias.findFirst({
      where: {
        fullAddress: aliasAddress.toLowerCase(),
        destinationHash: hashEmail(destinationEmail.toLowerCase()),
        isPrivate: false, // Only for public aliases
      },
    });

    if (alias && alias.managementToken) {
      const managementUrl = createManagementUrl(alias.managementToken);
      try {
        await sendManagementLinkEmail(getDestinationEmail(alias), alias.fullAddress, managementUrl);
      } catch (error) {
        logger.error('Resend management link send error:', error);
      }
    }

    // Don't reveal whether alias exists
    res.json({
      success: true,
      message: RESEND_MANAGEMENT_MESSAGE,
    });
  } catch (error) {
    logger.error('Resend management link error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process request',
    });
  }
}
