import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import routes from './routes';
import { globalErrorHandler, notFoundHandler } from './middleware/errorHandler';
import { swaggerSpec } from './config/swagger';
import logger from './utils/logger';

const app = express();

// Trust proxy - only trust X-Forwarded-For from loopback / private-network hops
// (Caddy reaches us over the docker bridge or 127.0.0.1). A public client cannot
// spoof its IP by sending its own X-Forwarded-For header.
app.set('trust proxy', 'loopback, uniquelocal');

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || process.env.BASE_URL || 'http://localhost:3000',
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
  // Only API traffic counts; static assets / SPA shell are not limited
  skip: (req) => !req.path.startsWith('/api/'),
});

app.use(limiter);

// Body parsing
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// Swagger API documentation (set ENABLE_API_DOCS=false to disable)
if (process.env.ENABLE_API_DOCS !== 'false') {
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'MakeAnon API Documentation',
  }));

  // Serve OpenAPI spec as JSON
  app.get('/api/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

// API routes
app.use('/api/v1', routes);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Serve index.html for all non-API routes (SPA support)
app.get('/{*splat}', (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handling
app.use(notFoundHandler);
app.use(globalErrorHandler);

export default app;
