import { Readable } from 'node:stream';
import { getCloudinaryClient } from '../../infrastructure/cloudinary/cloudinary.client';
import type { UploadResult, UploadStreamOptions } from './media.types';

export class MediaService {
  /**
   * Upload buffer lên Cloudinary qua upload_stream
   */
  async uploadStream(buffer: Buffer, options: UploadStreamOptions): Promise<UploadResult> {
    const client = getCloudinaryClient();

    const uploadOptions = {
      public_id: options.publicId,
      folder: options.folder,
      overwrite: true,
      resource_type: 'image' as const,
      // Tối ưu hóa tự động theo quyết định Q3
      fetch_format: 'auto',
      quality: 'auto',
      crop: 'limit',
      width: 1920,
      ...(options.transformation ? options.transformation : {}),
    };

    return new Promise<UploadResult>((resolve, reject) => {
      const stream = client.uploader.upload_stream(uploadOptions, (error, result) => {
        if (error || !result) {
          return reject(error || new Error('Upload to Cloudinary failed without result'));
        }
        resolve({
          secureUrl: result.secure_url,
          publicId: result.public_id,
        });
      });

      Readable.from(buffer).pipe(stream);
    });
  }

  /**
   * Xóa tài nguyên trên Cloudinary an toàn
   * Trả về true nếu thành công, false nếu gặp lỗi (không throw)
   */
  async deleteResource(publicId: string): Promise<boolean> {
    try {
      const client = getCloudinaryClient();
      const result = await client.uploader.destroy(publicId, { invalidate: true });
      return result?.result === 'ok' || result?.result === 'not found';
    } catch (error) {
      console.warn(`[MediaService] Failed to delete Cloudinary resource ${publicId}:`, error);
      return false;
    }
  }
}

export const mediaService = new MediaService();
