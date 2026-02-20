import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticatedRequest, JwtPayload } from '../types';
import prisma from '../services/database';
import { decryptEmail, EncryptedData } from '../utils/encryption';
import logger from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

/**
 * Authenticate requests using JWT token
 */
export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Authentication required. Please provide a valid token.',
      });
      return;
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

      // Verify user still exists and is active
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          email: true,
          emailIv: true,
          emailSalt: true,
          emailAuthTag: true,
          isEmailEncrypted: true,
          isActive: true,
          isAdmin: true,
        },
      });

      if (!user || !user.isActive) {
        res.status(401).json({
          success: false,
          error: 'User account not found or inactive.',
        });
        return;
      }

      let email = user.email;
      if (user.isEmailEncrypted && user.emailIv && user.emailSalt && user.emailAuthTag) {
        const encryptedData: EncryptedData = {
          ciphertext: user.email,
          iv: user.emailIv,
          salt: user.emailSalt,
          authTag: user.emailAuthTag,
        };
        email = decryptEmail(encryptedData, user.id);
      }

      req.user = {
        id: user.id,
        email,
        isAdmin: user.isAdmin,
      };

      next();
    } catch (jwtError) {
      if (jwtError instanceof jwt.TokenExpiredError) {
        res.status(401).json({
          success: false,
          error: 'Token has expired. Please log in again.',
        });
        return;
      }

      res.status(401).json({
        success: false,
        error: 'Invalid token.',
      });
      return;
    }
  } catch (error) {
    logger.error('Authentication middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed.',
    });
  }
}

/**
 * Generate JWT token
 */
export function generateToken(payload: { id: string; email: string; isAdmin: boolean }): string {
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

/**
 * Verify JWT token
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}
