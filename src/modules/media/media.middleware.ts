import type { Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { ApiError } from '../../common/errors/api-error';
import { validateImageBufferMagicBytes } from '../../common/utils/cloudinary.util';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MiB

const memoryStorage = multer.memoryStorage();

const baseMulter = multer({
  storage: memoryStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(
        new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Chỉ hỗ trợ file ảnh định dạng JPEG, PNG hoặc WebP')
      );
    }
    cb(null, true);
  },
});

/**
 * Middleware upload 1 ảnh duy nhất (dành cho ảnh bìa khu trọ)
 */
export function uploadSingleImage(fieldName: string): RequestHandler {
  const upload = baseMulter.single(fieldName);

  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: any) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new ApiError(413, 'FILE_TOO_LARGE', 'Dung lượng file ảnh vượt quá giới hạn tối đa 5MB'));
          }
          return next(new ApiError(400, 'INVALID_FILE_UPLOAD', err.message));
        }
        return next(err);
      }

      if (!req.file) {
        return next(new ApiError(400, 'FILE_REQUIRED', 'Vui lòng chọn file ảnh để tải lên'));
      }

      // Xác thực Magic Bytes nhị phân chống giả mạo
      const magicBytesCheck = validateImageBufferMagicBytes(req.file.buffer);
      if (!magicBytesCheck.valid) {
        return next(
          new ApiError(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            'Nội dung file không đúng định dạng ảnh hợp lệ (chỉ hỗ trợ JPEG, PNG, WebP)'
          )
        );
      }

      next();
    });
  };
}

/**
 * Middleware upload nhiều ảnh (dành cho bộ ảnh phòng trọ, tối đa maxCount)
 */
export function uploadMultipleImages(fieldName: string, maxCount: number = 10): RequestHandler {
  // Cho phép multer đọc tối đa maxCount files
  const upload = multer({
    storage: memoryStorage,
    limits: {
      fileSize: MAX_FILE_SIZE,
    },
    // Không reject cứng tại fileFilter để controller có thể thu thập danh sách Partial Success
  }).array(fieldName, maxCount);

  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: any) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new ApiError(413, 'FILE_TOO_LARGE', 'Dung lượng file ảnh vượt quá giới hạn tối đa 5MB'));
          }
          if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            if (err.field === fieldName) {
              return next(
                new ApiError(
                  400,
                  'ROOM_IMAGE_LIMIT_EXCEEDED',
                  `Số lượng file tải lên vượt quá giới hạn tối đa ${maxCount} ảnh trong một lần`
                )
              );
            }
            return next(
              new ApiError(
                400,
                'INVALID_FILE_UPLOAD',
                `Tên trường dữ liệu file không hợp lệ: "${err.field}". Yêu cầu tên trường là "${fieldName}"`
              )
            );
          }
          return next(new ApiError(400, 'INVALID_FILE_UPLOAD', err.message));
        }
        return next(err);
      }

      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return next(new ApiError(400, 'FILES_REQUIRED', 'Vui lòng chọn ít nhất 1 file ảnh để tải lên'));
      }

      next();
    });
  };
}
