import type { RequestHandler } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../../common/errors/api-error';
import { validateUploadedImageFile } from '../../common/utils/cloudinary.util';

const uuid = z.uuid();
const amountSchema = z.strictObject({
  amount: z.string().regex(/^[0-9]{1,12}(\.[0-9]{1,2})?$/)
    .transform((value) => new Prisma.Decimal(value)).refine((value) => value.gt(0)),
});
const rejectionSchema = z.strictObject({ rejectionReason: z.string().trim().min(10).max(1000) });
const receiveProof = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 1, fieldSize: 16, fileSize: 5 * 1024 * 1024 },
}).single('proof');

export const uploadDepositProof: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    return next(new ApiError(400, 'FILE_REQUIRED', 'Cần gửi ảnh biên nhận qua multipart/form-data'));
  }
  receiveProof(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(413, 'FILE_TOO_LARGE', 'Ảnh biên nhận phải có dung lượng tối đa 5 MiB'));
    }
    if (error) {
      return next(new ApiError(400, 'INVALID_FILE_UPLOAD', 'Dữ liệu tải lên không hợp lệ'));
    }
    if (!req.file) {
      return next(new ApiError(400, 'FILE_REQUIRED', 'Cần tải lên ảnh biên nhận'));
    }
    const image = validateUploadedImageFile(req.file.mimetype, req.file.buffer);
    if (!image.valid) {
      return next(new ApiError(400, 'INVALID_FILE_UPLOAD', image.reason ?? 'Ảnh biên nhận không hợp lệ'));
    }
    next();
  });
};

export function validateDepositId(value: unknown, field: 'contractId' | 'receiptId'): string {
  const id = uuid.safeParse(value);
  if (!id.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Mã định danh không hợp lệ', { [field]: ['Cần UUID hợp lệ'] });
  }
  return id.data;
}

export function validateDepositAmount(body: unknown): Prisma.Decimal {
  const result = amountSchema.safeParse(body);
  if (!result.success) {
    const message = 'Số tiền phải dương, tối đa 12 chữ số phần nguyên và 2 chữ số thập phân';
    throw new ApiError(400, 'VALIDATION_ERROR', message, { amount: [message] });
  }
  return result.data.amount;
}

export function validateDepositRejection(body: unknown): string {
  const result = rejectionSchema.safeParse(body);
  if (!result.success) {
    const message = 'Cần lý do từ chối dài từ 10 đến 1000 ký tự';
    throw new ApiError(400, 'VALIDATION_ERROR', message, { rejectionReason: [message] });
  }
  return result.data.rejectionReason;
}
