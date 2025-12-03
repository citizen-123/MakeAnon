import { Router } from 'express';
import {
  createAlias,
  getAliases,
  getAlias,
  updateAlias,
  deleteAlias,
  toggleAlias,
  getStats,
  getEmailLogs,
} from '../controllers/aliasController';
import { authenticate } from '../middleware/auth';
import { handleValidationErrors } from '../middleware/errorHandler';
import {
  validateCreateAlias,
  validateUpdateAlias,
  validateAliasId,
  validatePagination,
} from '../middleware/validation';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Stats and logs
router.get('/stats', getStats);
router.get('/logs', validatePagination, handleValidationErrors, getEmailLogs);

// CRUD operations
router.post('/', validateCreateAlias, handleValidationErrors, createAlias);
router.get('/', validatePagination, handleValidationErrors, getAliases);
router.get('/:id', validateAliasId, handleValidationErrors, getAlias);
router.put('/:id', validateUpdateAlias, handleValidationErrors, updateAlias);
router.delete('/:id', validateAliasId, handleValidationErrors, deleteAlias);
router.post('/:id/toggle', validateAliasId, handleValidationErrors, toggleAlias);

export default router;
