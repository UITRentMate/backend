import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler } from 'express';
import { ApiError, type ApiErrorResponse } from '../errors/api-error';

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const traceId = randomUUID();

  if (error instanceof ApiError) {
    const payload: ApiErrorResponse = {
      success: false,
      code: error.code,
      message: error.message,
      traceId,
      ...(error.errors && Object.keys(error.errors).length > 0 ? { errors: error.errors } : {}),
    };
    res.status(error.statusCode).json(payload);
    return;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    const payload: ApiErrorResponse = {
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'JSON không hợp lệ',
      traceId,
    };
    res.status(400).json(payload);
    return;
  }

  const payload: ApiErrorResponse = {
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'Lỗi hệ thống',
    traceId,
  };
  res.status(500).json(payload);
};
