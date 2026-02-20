import { Router, Request, Response, NextFunction } from 'express';
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import {
  createPublicAlias,
  getAliasByToken,
  updateAliasByToken,
  deleteAliasByToken,
  blockSender,
  unblockSender,
} from '../controllers/aliasController';
import {
  verifyAliasEmail,
  resendVerification,
  resendManagementLink,
} from '../controllers/verifyController';
import { listDomains } from '../controllers/domainController';
import { getRedisClient } from '../services/redis';

const router = Router();

let _managementLimiter: RateLimitRequestHandler | null = null;

function createRedisStore(): RedisStore | undefined {
  try {
    const client = getRedisClient();
    if (!client || typeof client.call !== 'function') return undefined;
    return new RedisStore({
      sendCommand: (...args: string[]) =>
        client.call(args[0], ...args.slice(1)) as Promise<string>,
      prefix: 'rl:mgmt:',
    });
  } catch {
    return undefined;
  }
}

function getManagementLimiter(): RateLimitRequestHandler {
  if (!_managementLimiter) {
    const store = createRedisStore();
    _managementLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      message: {
        success: false,
        error: 'Too many requests. Please try again later.',
      },
      standardHeaders: true,
      legacyHeaders: false,
      ...(store ? { store } : {}),
    });
  }
  return _managementLimiter;
}

function managementLimiter(req: Request, res: Response, next: NextFunction) {
  getManagementLimiter()(req, res, next);
}

// ============================================================================
// Public Alias Creation
// ============================================================================

// Create a new alias (no auth required)
router.post('/alias', createPublicAlias);

// ============================================================================
// Verification
// ============================================================================

// Verify email address
router.get('/verify/:token', verifyAliasEmail);

// Resend verification email
router.post('/verify/resend', managementLimiter, resendVerification);

// Request management link
router.post('/management-link', managementLimiter, resendManagementLink);

// ============================================================================
// Alias Management via Token
// ============================================================================

// Get alias by management token
router.get('/manage/:token', managementLimiter, getAliasByToken);

// Update alias via token
router.put('/manage/:token', managementLimiter, updateAliasByToken);
router.patch('/manage/:token', managementLimiter, updateAliasByToken);

// Delete alias via token
router.delete('/manage/:token', managementLimiter, deleteAliasByToken);

// Block/unblock senders
router.post('/manage/:token/block', managementLimiter, blockSender);
router.delete('/manage/:token/block/:senderId', managementLimiter, unblockSender);

// ============================================================================
// Domains (Public List)
// ============================================================================

// List available domains
router.get('/domains', listDomains);

export default router;
