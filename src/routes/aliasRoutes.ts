import { Router } from 'express';
import {
  createPrivateAlias,
  getAliases,
  getAlias,
  updateAlias,
  deleteAlias,
  toggleAlias,
  getStats,
  getEmailLogs,
} from '../controllers/aliasController';
import { authenticate } from '../middleware/auth';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Stats and logs
router.get('/stats', getStats);
router.get('/logs', getEmailLogs);

// CRUD operations for private aliases
router.post('/', createPrivateAlias);
router.get('/', getAliases);
router.get('/:id', getAlias);
router.put('/:id', updateAlias);
router.patch('/:id', updateAlias);
router.delete('/:id', deleteAlias);
router.post('/:id/toggle', toggleAlias);

export default router;
