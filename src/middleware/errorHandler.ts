import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import logger from '../utils/logger';

export function handleValidationErrors(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array().map((err) => ({
        field: 'path' in err ? err.path : 'unknown',
        message: err.msg,
      })),
    });
    return;
  }

  next();
}

type HttpLikeError = Error & {
  status?: number;
  statusCode?: number;
  type?: string;
  code?: string;
};

function sendError(res: Response, status: number, error: string): void {
  res.status(status).json({ success: false, error });
}

export function globalErrorHandler(
  err: HttpLikeError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Headers already sent: let Express close the connection
  if (res.headersSent) {
    _next(err);
    return;
  }

  // Body-parser errors (malformed JSON, oversized payloads, etc.) are client errors
  if (err.type === 'entity.parse.failed') {
    sendError(res, 400, 'Malformed JSON in request body');
    return;
  }
  if (err.type === 'entity.too.large') {
    sendError(res, 413, 'Request body too large');
    return;
  }

  // Prisma known request errors
  if (err.name === 'PrismaClientKnownRequestError') {
    switch (err.code) {
      case 'P2002': // Unique constraint violation
        logger.warn(`Prisma unique constraint violation on ${req.method} ${req.path}`);
        sendError(res, 409, 'Resource already exists');
        return;
      case 'P2025': // Record not found
        logger.warn(`Prisma record not found on ${req.method} ${req.path}`);
        sendError(res, 404, 'Resource not found');
        return;
      default:
        logger.error('Database error:', err);
        sendError(res, 500, 'Database operation failed');
        return;
    }
  }

  // Other errors carrying an explicit 4xx status (e.g. http-errors from body-parser)
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    logger.warn(`Client error ${status} on ${req.method} ${req.path}: ${err.message}`);
    sendError(res, status, 'Bad request');
    return;
  }

  logger.error('Unhandled error:', err);

  // Never leak internal error messages in production
  sendError(
    res,
    500,
    process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message
  );
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: 'Not found',
  });
}
