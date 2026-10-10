import { Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../services/database';
import { generateToken } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
import { isValidEmail } from '../utils/helpers';
import { encryptEmail, decryptEmail, hashEmail, EncryptedData } from '../utils/encryption';
import { invalidateAliasCache } from '../services/redis';
import logger from '../utils/logger';

const SALT_ROUNDS = 12;

const INVALID_CREDENTIALS = 'Invalid email or password';

// Valid cost-12 bcrypt hash of a random throwaway string. Compared against when
// the account does not exist so that login timing does not leak existence.
const DUMMY_PASSWORD_HASH = '$2b$12$3GK5L0rOlmTnO.iWgbJ5ieUPuluwW946DWpgjIasUKIDJHmv/Ycse';

/**
 * Encrypt a user's email for database storage
 */
function encryptUserEmail(email: string, userId: string) {
  const encrypted = encryptEmail(email, userId);
  return {
    email: encrypted.ciphertext,
    emailHash: hashEmail(email),
    emailIv: encrypted.iv,
    emailSalt: encrypted.salt,
    emailAuthTag: encrypted.authTag,
    isEmailEncrypted: true,
  };
}

/**
 * Decrypt a user's email from database
 */
function decryptUserEmail(user: {
  id: string;
  email: string;
  emailIv?: string | null;
  emailSalt?: string | null;
  emailAuthTag?: string | null;
  isEmailEncrypted?: boolean;
}): string {
  if (user.isEmailEncrypted && user.emailIv && user.emailSalt && user.emailAuthTag) {
    const encryptedData: EncryptedData = {
      ciphertext: user.email,
      iv: user.emailIv,
      salt: user.emailSalt,
      authTag: user.emailAuthTag,
    };
    return decryptEmail(encryptedData, user.id);
  }
  return user.email;
}

/**
 * Sign up for an account
 *
 * Existing emails get a 409. We deliberately keep that (rather than a generic
 * "check your email" response) because signup issues a session token directly
 * and there is no email-confirmation flow to fall back on; enumeration via this
 * endpoint is mitigated by a strict per-IP rate limit (see authRoutes).
 *
 * Admin rights are never granted here. Promote admins manually.
 */
export async function signup(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, name } = req.body;

    if (!email || !isValidEmail(email)) {
      res.status(400).json({
        success: false,
        error: 'Please provide a valid email address',
      });
      return;
    }

    if (!password || typeof password !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Password is required',
      });
      return;
    }

    // Check if user already exists. Legacy passwordless accounts are NOT
    // claimable via signup: allowing that let anyone who knew the email set a
    // password and take over the account.
    const emailHashValue = hashEmail(email);
    const existingUser = await prisma.user.findUnique({
      where: { emailHash: emailHashValue },
      select: { id: true },
    });

    if (existingUser) {
      res.status(409).json({
        success: false,
        error: 'An account with this email already exists',
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const tempId = crypto.randomUUID();
    const encryptedFields = encryptUserEmail(email.toLowerCase(), tempId);

    // Create user (never admin; see function doc)
    const user = await prisma.user.create({
      data: {
        id: tempId,
        ...encryptedFields,
        password: hashedPassword,
        name: name || null,
        isAdmin: false,
      },
      select: {
        id: true,
        email: true,
        emailIv: true,
        emailSalt: true,
        emailAuthTag: true,
        isEmailEncrypted: true,
        name: true,
        isAdmin: true,
        maxAliases: true,
        tokenVersion: true,
        createdAt: true,
      },
    });

    const plaintextEmail = decryptUserEmail(user);

    const token = generateToken({ id: user.id, tokenVersion: user.tokenVersion });

    logger.info('New user registered: [encrypted]');

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: plaintextEmail,
          name: user.name,
          isAdmin: user.isAdmin,
          maxAliases: user.maxAliases,
          createdAt: user.createdAt,
        },
        token,
      },
      message: 'Account created successfully',
    });
  } catch (error) {
    logger.error('Signup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create account',
    });
  }
}

/**
 * Log in to an account
 *
 * Every failure mode (unknown email, deactivated, no password, wrong password)
 * returns the same 401 and performs one bcrypt comparison, so responses do not
 * reveal whether an account exists.
 */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Email is required',
      });
      return;
    }

    const suppliedPassword = typeof password === 'string' ? password : '';

    const user = await prisma.user.findUnique({
      where: { emailHash: hashEmail(email) },
    });

    // Always run exactly one bcrypt compare to equalise timing
    const hashToCompare = user?.password || DUMMY_PASSWORD_HASH;
    const passwordMatches = await bcrypt.compare(suppliedPassword, hashToCompare);

    if (!user || !user.password || !user.isActive || !passwordMatches) {
      res.status(401).json({
        success: false,
        error: INVALID_CREDENTIALS,
      });
      return;
    }

    const plaintextEmail = decryptUserEmail(user);

    const token = generateToken({ id: user.id, tokenVersion: user.tokenVersion });

    logger.info('User logged in: [encrypted]');

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: plaintextEmail,
          name: user.name,
          isAdmin: user.isAdmin,
          maxAliases: user.maxAliases,
        },
        token,
      },
      message: 'Login successful',
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed',
    });
  }
}

/**
 * Get current user profile
 */
export async function getProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailIv: true,
        emailSalt: true,
        emailAuthTag: true,
        isEmailEncrypted: true,
        name: true,
        isAdmin: true,
        emailVerified: true,
        maxAliases: true,
        createdAt: true,
        _count: {
          select: { aliases: true },
        },
      },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    const plaintextEmail = decryptUserEmail(user);

    res.json({
      success: true,
      data: {
        id: user.id,
        email: plaintextEmail,
        name: user.name,
        isAdmin: user.isAdmin,
        emailVerified: user.emailVerified,
        maxAliases: user.maxAliases,
        aliasCount: user._count.aliases,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    logger.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get profile',
    });
  }
}

/**
 * Update user profile
 */
export async function updateProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { name } = req.body;

    const user = await prisma.user.update({
      where: { id: userId },
      data: { name },
      select: {
        id: true,
        email: true,
        emailIv: true,
        emailSalt: true,
        emailAuthTag: true,
        isEmailEncrypted: true,
        name: true,
        isAdmin: true,
        createdAt: true,
      },
    });

    const decryptedEmail = decryptUserEmail(user);

    res.json({
      success: true,
      data: {
        id: user.id,
        email: decryptedEmail,
        name: user.name,
        isAdmin: user.isAdmin,
        createdAt: user.createdAt,
      },
      message: 'Profile updated successfully',
    });
  } catch (error) {
    logger.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile',
    });
  }
}

/**
 * Set or change password
 */
export async function changePassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({
        success: false,
        error: 'New password must be at least 8 characters',
      });
      return;
    }

    // Get current user with password
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // If user has an existing password, verify it
    if (user.password) {
      if (!currentPassword) {
        res.status(400).json({
          success: false,
          error: 'Current password is required',
        });
        return;
      }

      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      if (!isValidPassword) {
        res.status(401).json({
          success: false,
          error: 'Current password is incorrect',
        });
        return;
      }
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);

    // Update password and bump tokenVersion so every previously issued JWT is revoked
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
      },
      select: { id: true, tokenVersion: true },
    });

    logger.info(`Password ${user.password ? 'changed' : 'set'} for user: [encrypted]`);

    // Issue a fresh token so the current session keeps working
    const token = generateToken({ id: updated.id, tokenVersion: updated.tokenVersion });

    res.json({
      success: true,
      data: { token },
      message: user.password ? 'Password changed successfully' : 'Password set successfully',
    });
  } catch (error) {
    logger.error('Change password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password',
    });
  }
}

/**
 * Delete account
 */
export async function deleteAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { password, confirmEmail } = req.body;

    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Verify by password or email confirmation
    if (user.password) {
      if (!password) {
        res.status(400).json({
          success: false,
          error: 'Password is required to delete account',
        });
        return;
      }

      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        res.status(401).json({
          success: false,
          error: 'Password is incorrect',
        });
        return;
      }
    } else {
      const plaintextEmail = decryptUserEmail(user);
      if (confirmEmail?.toLowerCase() !== plaintextEmail) {
        res.status(400).json({
          success: false,
          error: 'Please confirm by entering your email address',
        });
        return;
      }
    }

    // Delete the user's aliases explicitly (the FK also cascades, but doing it here
    // lets us keep Domain.aliasCount accurate), then the user, atomically.
    const deletedAliases = await prisma.$transaction(async (tx) => {
      const aliases = await tx.alias.findMany({
        where: { userId },
        select: { id: true, fullAddress: true, domainId: true },
      });

      if (aliases.length > 0) {
        await tx.alias.deleteMany({ where: { userId } });

        const perDomain = new Map<string, number>();
        for (const alias of aliases) {
          perDomain.set(alias.domainId, (perDomain.get(alias.domainId) || 0) + 1);
        }
        for (const [domainId, count] of perDomain) {
          await tx.domain.update({
            where: { id: domainId },
            data: { aliasCount: { decrement: count } },
          });
        }
      }

      await tx.user.delete({ where: { id: userId } });

      return aliases;
    });

    // Drop cached alias lookups so the SMTP server stops forwarding immediately.
    // Done after commit; a cache failure must not undo the deletion.
    await Promise.all(
      deletedAliases.map((alias) =>
        invalidateAliasCache(alias.fullAddress).catch((err) => {
          logger.warn('Failed to invalidate alias cache after account deletion:', err);
        })
      )
    );

    logger.info(`Account deleted: [encrypted] (${deletedAliases.length} aliases removed)`);

    res.json({
      success: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    logger.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete account',
    });
  }
}
