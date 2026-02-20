import { Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../services/database';
import { generateToken } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
import { isValidEmail } from '../utils/helpers';
import { encryptEmail, decryptEmail, hashEmail, EncryptedData } from '../utils/encryption';
import logger from '../utils/logger';

const SALT_ROUNDS = 12;

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
 * Password is optional - only required for private alias management
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

    // Check if user already exists
    const emailHashValue = hashEmail(email);
    const existingUser = await prisma.user.findUnique({
      where: { emailHash: emailHashValue },
    });

    if (existingUser) {
      // If user exists but has no password and one is being set
      if (!existingUser.password && password) {
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const encryptedFields = encryptUserEmail(email.toLowerCase(), existingUser.id);
        const user = await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            password: hashedPassword,
            name: name || existingUser.name,
            ...encryptedFields,
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
            createdAt: true,
          },
        });

        const plaintextEmail = decryptUserEmail(user);
        const token = generateToken({
          id: user.id,
          email: plaintextEmail,
          isAdmin: user.isAdmin,
        });

        res.json({
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
          message: 'Password set successfully. You can now manage private aliases.',
        });
        return;
      }

      res.status(409).json({
        success: false,
        error: 'An account with this email already exists',
      });
      return;
    }

    // Hash password if provided
    const hashedPassword = password ? await bcrypt.hash(password, SALT_ROUNDS) : null;

    // Check if this should be an admin (first user or configured admin)
    const isFirstUser = (await prisma.user.count()) === 0;
    const isConfiguredAdmin = email.toLowerCase() === process.env.ADMIN_EMAIL?.toLowerCase();

    const tempId = crypto.randomUUID();
    const encryptedFields = encryptUserEmail(email.toLowerCase(), tempId);

    // Create user
    const user = await prisma.user.create({
      data: {
        id: tempId,
        ...encryptedFields,
        password: hashedPassword,
        name: name || null,
        isAdmin: isFirstUser || isConfiguredAdmin,
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
        createdAt: true,
      },
    });

    const plaintextEmail = decryptUserEmail(user);

    // Generate token
    const token = generateToken({
      id: user.id,
      email: plaintextEmail,
      isAdmin: user.isAdmin,
    });

    logger.info(`New user registered: [encrypted]${user.isAdmin ? ' (admin)' : ''}`);

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
      message: password
        ? 'Account created successfully'
        : 'Account created. Set a password to manage private aliases.',
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
 */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    if (!email) {
      res.status(400).json({
        success: false,
        error: 'Email is required',
      });
      return;
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { emailHash: hashEmail(email) },
    });

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    if (!user.isActive) {
      res.status(401).json({
        success: false,
        error: 'Account is deactivated',
      });
      return;
    }

    // Check if user has a password set
    if (!user.password) {
      res.status(401).json({
        success: false,
        error: 'No password set for this account. Please sign up with a password first.',
      });
      return;
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    const plaintextEmail = decryptUserEmail(user);

    // Generate token
    const token = generateToken({
      id: user.id,
      email: plaintextEmail,
      isAdmin: user.isAdmin,
    });

    logger.info(`User logged in: [encrypted]`);

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
        name: true,
        isAdmin: true,
        createdAt: true,
      },
    });

    res.json({
      success: true,
      data: user,
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

    // Update password
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    logger.info(`Password ${user.password ? 'changed' : 'set'} for user: [encrypted]`);

    res.json({
      success: true,
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

    // Delete user (cascades to aliases via Prisma)
    await prisma.user.delete({
      where: { id: userId },
    });

    logger.info(`Account deleted: [encrypted]`);

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
