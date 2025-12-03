import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import routes from './routes';
import { globalErrorHandler, notFoundHandler } from './middleware/errorHandler';
import logger from './utils/logger';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: {
    success: false,
    error: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// API routes
app.use('/api/v1', routes);

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'Welcome to Emask - Email Masking Service',
    version: '1.0.0',
    documentation: '/api/v1/health',
  });
});

// Error handling
app.use(notFoundHandler);
app.use(globalErrorHandler);

export default app;
