import { Router, Request, Response, NextFunction } from 'express';
import rateLimit, { Options, RateLimitRequestHandler } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import {
  signup,
  login,
  getProfile,
  updateProfile,
  changePassword,
  deleteAccount,
} from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import { handleValidationErrors } from '../middleware/errorHandler';
import {
  validateSignup,
  validateLogin,
  validateChangePassword,
} from '../middleware/validation';
import { getRedisClient } from '../services/redis';
import { hashEmail } from '../utils/encryption';

const router = Router();

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

const tooManyRequests = {
  success: false,
  error: 'Too many attempts. Please try again later.',
};

/**
 * Use a shared Redis store when Redis is up so limits hold across restarts and
 * instances; otherwise fall back to express-rate-limit's in-memory store.
 */
function createRedisStore(prefix: string): RedisStore | undefined {
  try {
    const client = getRedisClient();
    if (!client || client.status !== 'ready' || typeof client.call !== 'function') {
      return undefined;
    }
    return new RedisStore({
      sendCommand: (...args: string[]) =>
        client.call(args[0], ...args.slice(1)) as Promise<string>,
      prefix,
    });
  } catch {
    return undefined;
  }
}

/**
 * Build the limiter on first use (Redis connects after module load).
 */
function lazyLimiter(prefix: string, options: Partial<Options>) {
  let limiter: RateLimitRequestHandler | null = null;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!limiter) {
      const store = createRedisStore(prefix);
      limiter = rateLimit({
        message: tooManyRequests,
        standardHeaders: true,
        legacyHeaders: false,
        // Fail open if Redis errors mid-request rather than locking everyone out
        passOnStoreError: true,
        validate: { creationStack: false },
        ...options,
        ...(store ? { store } : {}),
      });
    }
    limiter(req, res, next);
  };
}

// Login: 10 attempts / 15 min per client IP
const loginIpLimiter = lazyLimiter('rl:login:ip:', {
  windowMs: FIFTEEN_MINUTES,
  limit: 10,
});

// Login: 5 failed attempts / 15 min per target account (keyed by email HMAC,
// so plaintext addresses never reach Redis). Successful logins don't count.
const loginAccountLimiter = lazyLimiter('rl:login:acct:', {
  windowMs: FIFTEEN_MINUTES,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    return hashEmail(email);
  },
});

// Signup: 5 / hour per client IP (also limits account enumeration via 409)
const signupIpLimiter = lazyLimiter('rl:signup:ip:', {
  windowMs: ONE_HOUR,
  limit: 5,
});

// Public routes
router.post('/signup', signupIpLimiter, validateSignup, handleValidationErrors, signup);
router.post(
  '/login',
  loginIpLimiter,
  validateLogin,
  handleValidationErrors,
  loginAccountLimiter,
  login
);

// Protected routes
router.get('/profile', authenticate, getProfile);
router.put('/profile', authenticate, updateProfile);
router.post('/change-password', authenticate, validateChangePassword, handleValidationErrors, changePassword);
router.delete('/account', authenticate, deleteAccount);

export default router;
