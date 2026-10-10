import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticatedRequest, JwtPayload } from '../types';
import prisma from '../services/database';
import { decryptEmail, EncryptedData } from '../utils/encryption';
import logger from '../utils/logger';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}
const JWT_SECRET: string = process.env.JWT_SECRET;

// Pin the algorithm so tokens signed with anything else (e.g. "none") are rejected
const JWT_ALGORITHM: jwt.Algorithm = 'HS256';

function isValidPayload(decoded: unknown): decoded is JwtPayload {
  if (!decoded || typeof decoded !== 'object') return false;
  const p = decoded as Record<string, unknown>;
  return typeof p.id === 'string' && p.id.length > 0 && typeof p.tv === 'number';
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

    let decoded: unknown;
    try {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
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

    if (!isValidPayload(decoded)) {
      res.status(401).json({
        success: false,
        error: 'Invalid token.',
      });
      return;
    }

    // Verify user still exists, is active, and the token has not been revoked
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
        tokenVersion: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({
        success: false,
        error: 'User account not found or inactive.',
      });
      return;
    }

    if (user.tokenVersion !== decoded.tv) {
      res.status(401).json({
        success: false,
        error: 'Token has been revoked. Please log in again.',
      });
      return;
    }

    // Email and admin flag always come from the database, never from the token
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
  } catch (error) {
    logger.error('Authentication middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed.',
    });
  }
}

/**
 * Generate JWT token. Only the user id and token version are embedded.
 */
export function generateToken(payload: { id: string; tokenVersion: number }): string {
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  const claims: JwtPayload = { id: payload.id, tv: payload.tokenVersion };
  return jwt.sign(claims, JWT_SECRET, {
    expiresIn,
    algorithm: JWT_ALGORITHM,
  } as jwt.SignOptions);
}

/**
 * Verify JWT token signature/expiry and payload shape.
 * Note: does NOT check tokenVersion against the database; use `authenticate` for that.
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
    return isValidPayload(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
