import type { ErrorRequestHandler } from 'express';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly errors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
      ...(error.errors ? { errors: error.errors } : {}),
    });
    return;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'JSON không hợp lệ' });
    return;
  }

  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' });
};
