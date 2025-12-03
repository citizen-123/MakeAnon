import { Router } from 'express';
import {
  listDomains,
  getDomain,
  createDomainHandler,
  updateDomainHandler,
  deleteDomainHandler,
  toggleDomainHandler,
} from '../controllers/domainController';
import { authenticate } from '../middleware/auth';

const router = Router();

// Public routes
router.get('/', listDomains);
router.get('/:id', getDomain);

// Admin routes
router.post('/', authenticate, createDomainHandler);
router.put('/:id', authenticate, updateDomainHandler);
router.patch('/:id', authenticate, updateDomainHandler);
router.delete('/:id', authenticate, deleteDomainHandler);
router.post('/:id/toggle', authenticate, toggleDomainHandler);

export default router;
