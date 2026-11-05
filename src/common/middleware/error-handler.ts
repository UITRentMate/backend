import { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError, type ApiErrorResponse } from '../errors/api-error';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const traceId = randomUUID();

  if (err instanceof ApiError) {
    const payload: ApiErrorResponse = {
      success: false,
      code: err.code,
      message: err.message,
      traceId,
      ...(err.errors && Object.keys(err.errors).length > 0 ? { errors: err.errors } : {}),
    };
    res.status(err.statusCode).json(payload);
    return;
  }

  // Lỗi nội bộ không xác định: ghi log kỹ thuật và không lộ chi tiết nội bộ ra client
  console.error('[UNHANDLED_ERROR]', err);

  const payload: ApiErrorResponse = {
    success: false,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Đã có sự cố xảy ra trên hệ thống. Vui lòng thử lại sau.',
    traceId,
  };
  res.status(500).json(payload);
}
