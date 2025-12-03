import { Router } from 'express';
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

const router = Router();

// Public routes
router.post('/signup', validateSignup, handleValidationErrors, signup);
router.post('/login', validateLogin, handleValidationErrors, login);

// Protected routes
router.get('/profile', authenticate, getProfile);
router.put('/profile', authenticate, updateProfile);
router.post('/change-password', authenticate, validateChangePassword, handleValidationErrors, changePassword);
router.delete('/account', authenticate, deleteAccount);

export default router;
