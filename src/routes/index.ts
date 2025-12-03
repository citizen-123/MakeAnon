import { Router } from 'express';
import authRoutes from './authRoutes';
import aliasRoutes from './aliasRoutes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/aliases', aliasRoutes);

// Health check
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Emask API is running',
    timestamp: new Date().toISOString(),
  });
});

export default router;
