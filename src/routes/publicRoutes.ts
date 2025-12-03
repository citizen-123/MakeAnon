import { Router } from 'express';
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
router.post('/verify/resend', resendVerification);

// Request management link
router.post('/management-link', resendManagementLink);

// ============================================================================
// Alias Management via Token
// ============================================================================

// Get alias by management token
router.get('/manage/:token', getAliasByToken);

// Update alias via token
router.put('/manage/:token', updateAliasByToken);
router.patch('/manage/:token', updateAliasByToken);

// Delete alias via token
router.delete('/manage/:token', deleteAliasByToken);

// Block/unblock senders
router.post('/manage/:token/block', blockSender);
router.delete('/manage/:token/block/:senderId', unblockSender);

// ============================================================================
// Domains (Public List)
// ============================================================================

// List available domains
router.get('/domains', listDomains);

export default router;
