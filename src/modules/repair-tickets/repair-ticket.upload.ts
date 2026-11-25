import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import type { RepairAttachmentStage } from '../../common/constants/phase3-status';
import { ApiError } from '../../common/errors/api-error';
import { validateUploadedImageFile } from '../../common/utils/cloudinary.util';
import { mediaService } from '../media/media.service';
import type { UploadedRepairAttachment } from './repair-ticket.types';

export const REPAIR_ATTACHMENT_FIELD_NAME = 'attachments';
export const MAX_REPAIR_ATTACHMENT_FILE_SIZE = 5 * 1024 * 1024; // 5 MiB

const memoryStorage = multer.memoryStorage();

export interface UploadRepairAttachmentsOptions {
  minFiles: number;
  maxFiles: number;
  allowJsonWithoutFiles?: boolean;
}

/**
 * Middleware đọc file ảnh sửa chữa bằng memoryStorage, kiểm tra số lượng biên
 * và xác thực MIME + Magic Bytes (JPEG/PNG/WEBP) trước khi vào Controller/Service.
 */
export function uploadRepairAttachments(options: UploadRepairAttachmentsOptions): RequestHandler {
  const upload = multer({
    storage: memoryStorage,
    limits: {
      fileSize: MAX_REPAIR_ATTACHMENT_FILE_SIZE,
    },
  }).array(REPAIR_ATTACHMENT_FIELD_NAME, options.maxFiles);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.allowJsonWithoutFiles && req.is('application/json')) {
      req.files = [];
      next();
      return;
    }

    upload(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof ApiError) {
          next(err);
          return;
        }
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            next(
              new ApiError(
                413,
                'FILE_TOO_LARGE',
                'Dung lượng file ảnh vượt quá giới hạn tối đa 5MB',
              ),
            );
            return;
          }
          if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            if (err.field === REPAIR_ATTACHMENT_FIELD_NAME) {
              next(
                new ApiError(
                  400,
                  'ATTACHMENT_LIMIT_EXCEEDED',
                  `Số lượng ảnh tải lên vượt quá giới hạn tối đa ${options.maxFiles} ảnh`,
                ),
              );
              return;
            }
            next(
              new ApiError(
                400,
                'INVALID_FILE_UPLOAD',
                `Tên trường dữ liệu file không hợp lệ: "${err.field ?? ''}". Yêu cầu tên trường là "${REPAIR_ATTACHMENT_FIELD_NAME}"`,
              ),
            );
            return;
          }
          next(new ApiError(400, 'INVALID_FILE_UPLOAD', err.message));
          return;
        }
        next(new ApiError(400, 'INVALID_FILE_UPLOAD', 'Dữ liệu multipart tải lên không hợp lệ'));
        return;
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];

      if (files.length < options.minFiles) {
        next(
          new ApiError(
            400,
            'ATTACHMENTS_REQUIRED',
            `Vui lòng đính kèm ít nhất ${options.minFiles} ảnh hợp lệ`,
          ),
        );
        return;
      }

      if (files.length > options.maxFiles) {
        next(
          new ApiError(
            400,
            'ATTACHMENT_LIMIT_EXCEEDED',
            `Số lượng ảnh tải lên vượt quá giới hạn tối đa ${options.maxFiles} ảnh`,
          ),
        );
        return;
      }

      for (const file of files) {
        const validation = validateUploadedImageFile(file.mimetype, file.buffer);
        if (!validation.valid) {
          next(
            new ApiError(
              415,
              'UNSUPPORTED_MEDIA_TYPE',
              validation.reason ??
                'Nội dung file không đúng định dạng ảnh hợp lệ (chỉ hỗ trợ JPEG, PNG, WebP)',
            ),
          );
          return;
        }
      }

      next();
    });
  };
}

export function buildRepairAttachmentPublicId(
  propertyId: string,
  ticketId: string,
  stage: RepairAttachmentStage,
  attachmentId: string,
): string {
  return `rentmate/repairs/${propertyId}/${ticketId}/${stage.toLowerCase()}_${attachmentId}`;
}

export async function cleanupUploadedRepairFiles(publicIds: readonly string[]): Promise<void> {
  if (publicIds.length === 0) {
    return;
  }

  const results = await Promise.allSettled(
    publicIds.map((publicId) => mediaService.deleteResource(publicId)),
  );

  results.forEach((result, index) => {
    const publicId = publicIds[index];
    if (result.status === 'rejected') {
      console.warn(`[RepairTicketUpload] Không thể xóa ảnh rollback ${publicId}:`, result.reason);
    } else if (!result.value) {
      console.warn(`[RepairTicketUpload] Xóa ảnh rollback ${publicId} trả về false`);
    }
  });
}

export async function uploadRepairFilesToCloudinary(
  files: readonly Express.Multer.File[],
  params: {
    propertyId: string;
    ticketId: string;
    stage: RepairAttachmentStage;
  },
): Promise<UploadedRepairAttachment[]> {
  const uploaded: UploadedRepairAttachment[] = [];

  for (const file of files) {
    const attachmentId = randomUUID();
    const publicId = buildRepairAttachmentPublicId(
      params.propertyId,
      params.ticketId,
      params.stage,
      attachmentId,
    );

    try {
      const result = await mediaService.uploadStream(file.buffer, { publicId });
      uploaded.push({
        id: attachmentId,
        fileUrl: result.secureUrl,
        publicId: result.publicId || publicId,
      });
    } catch {
      await cleanupUploadedRepairFiles(uploaded.map((item) => item.publicId));
      throw new ApiError(
        502,
        'CLOUDINARY_UPLOAD_FAILED',
        'Không thể tải ảnh đính kèm lên hệ thống lưu trữ, vui lòng thử lại',
      );
    }
  }

  return uploaded;
}
