import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public isOperational = true
  ) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
  }
}

export function globalErrorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const isOperational = err instanceof AppError ? err.isOperational : false;

  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    statusCode,
    isOperational,
    ip: req.ip
  });

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message: isOperational ? err.message : 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export { AppError };
