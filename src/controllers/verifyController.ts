import { Request, Response } from 'express';
import prisma from '../services/database';
import { verifyToken } from '../services/verificationService';
import { sendManagementLinkEmail } from '../services/verificationService';
import { createManagementUrl } from '../utils/helpers';
import logger from '../utils/logger';

/**
 * Verify an alias email address
 */
export async function verifyAliasEmail(req: Request, res: Response): Promise<void> {
  try {
    const { token } = req.params;

    const result = await verifyToken(token, 'alias_verify');

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
      });
      return;
    }

    const metadata = result.metadata as { aliasAddress: string; managementToken: string };

    // Find and activate the alias
    const alias = await prisma.alias.findFirst({
      where: {
        fullAddress: metadata.aliasAddress,
        managementToken: metadata.managementToken,
      },
    });

    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found',
      });
      return;
    }

    // Activate the alias
    await prisma.alias.update({
      where: { id: alias.id },
      data: {
        emailVerified: true,
        isActive: true,
      },
    });

    // Send management link
    const managementUrl = createManagementUrl(alias.managementToken!);
    await sendManagementLinkEmail(alias.destinationEmail, alias.fullAddress, managementUrl);

    logger.info(`Alias verified: ${alias.fullAddress}`);

    // Redirect to management page or return success
    const baseUrl = process.env.BASE_URL || '';
    if (baseUrl) {
      res.redirect(`${baseUrl}/verified?alias=${encodeURIComponent(alias.fullAddress)}`);
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
 * Resend verification email
 */
export async function resendVerification(req: Request, res: Response): Promise<void> {
  try {
    const { aliasId, email } = req.body;

    if (!aliasId && !email) {
      res.status(400).json({
        success: false,
        error: 'Please provide alias ID or email',
      });
      return;
    }

    // Find unverified alias
    const alias = await prisma.alias.findFirst({
      where: {
        ...(aliasId && { id: aliasId }),
        ...(email && { destinationEmail: email.toLowerCase() }),
        emailVerified: false,
      },
    });

    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'No unverified alias found',
      });
      return;
    }

    // Import and use the function
    const { sendAliasVerificationEmail } = await import('../services/verificationService');
    const sent = await sendAliasVerificationEmail(
      alias.destinationEmail,
      alias.fullAddress,
      alias.managementToken!
    );

    if (!sent) {
      res.status(500).json({
        success: false,
        error: 'Failed to send verification email. Please try again later.',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Verification email sent. Please check your inbox.',
    });
  } catch (error) {
    logger.error('Resend verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resend verification email',
    });
  }
}

/**
 * Request management link to be resent
 */
export async function resendManagementLink(req: Request, res: Response): Promise<void> {
  try {
    const { aliasAddress, destinationEmail } = req.body;

    if (!aliasAddress || !destinationEmail) {
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
        destinationEmail: destinationEmail.toLowerCase(),
        isPrivate: false, // Only for public aliases
      },
    });

    if (!alias || !alias.managementToken) {
      // Don't reveal whether alias exists
      res.json({
        success: true,
        message: 'If the alias exists, a management link has been sent to the destination email.',
      });
      return;
    }

    const managementUrl = createManagementUrl(alias.managementToken);
    await sendManagementLinkEmail(alias.destinationEmail, alias.fullAddress, managementUrl);

    res.json({
      success: true,
      message: 'If the alias exists, a management link has been sent to the destination email.',
    });
  } catch (error) {
    logger.error('Resend management link error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process request',
    });
  }
}
