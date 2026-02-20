import { Router } from 'express';
import rateLimit from 'express-rate-limit';
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

const router = Router();

const managementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

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
