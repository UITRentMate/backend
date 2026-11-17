/**
 * Trích xuất public_id từ URL Cloudinary
 * Ví dụ:
 * https://res.cloudinary.com/demo/image/upload/v1731835000/rentmate/rooms/r-101/img-001.webp
 * -> rentmate/rooms/r-101/img-001
 */
export function extractCloudinaryPublicId(url: string): string | null {
  if (!url || typeof url !== 'string' || !url.includes('res.cloudinary.com')) {
    return null;
  }

  try {
    const uploadIndex = url.indexOf('/upload/');
    if (uploadIndex === -1) {
      return null;
    }

    // Lấy phần đường dẫn sau /upload/
    let pathAfterUpload = url.substring(uploadIndex + '/upload/'.length);

    // Tách các path segments
    const segments = pathAfterUpload.split('/');

    // Bỏ qua các segments là transformation (ví dụ: c_limit,w_1920 hoặc f_auto,q_auto) và version (v1731835000)
    let startIndex = 0;
    while (startIndex < segments.length) {
      const segment = segments[startIndex];
      // Nếu là version: v followed by digits
      if (/^v\d+$/.test(segment)) {
        startIndex++;
        break; // Sau version luôn là public_id path
      }
      // Nếu là transformation (chứa dấu phẩy, gạch dưới phổ biến như c_fill, w_500, etc.)
      if (segment.includes('_') || segment.includes(',')) {
        startIndex++;
        continue;
      }
      break;
    }

    if (startIndex >= segments.length) {
      return null;
    }

    const publicIdWithExt = segments.slice(startIndex).join('/');
    // Bỏ đuôi mở rộng file (.jpg, .png, .webp, ...)
    const lastDotIndex = publicIdWithExt.lastIndexOf('.');
    if (lastDotIndex !== -1) {
      return publicIdWithExt.substring(0, lastDotIndex);
    }

    return publicIdWithExt;
  } catch {
    return null;
  }
}

/**
 * Tạo public_id cho ảnh bìa khu trọ
 */
export function buildPropertyCoverPublicId(propertyId: string): string {
  return `rentmate/properties/${propertyId}/cover_${Date.now()}`;
}

/**
 * Tạo public_id cho ảnh phòng trọ
 */
export function buildRoomImagePublicId(roomId: string, imageId: string): string {
  return `rentmate/rooms/${roomId}/${imageId}`;
}

/**
 * Kiểm tra tính hợp lệ của định dạng ảnh bằng chữ ký nhị phân (Magic Bytes)
 * Hỗ trợ: JPEG, PNG, WEBP
 */
export function validateImageBufferMagicBytes(buffer: Buffer): { valid: boolean; format?: string } {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 3) {
    return { valid: false };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, format: 'jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { valid: true, format: 'png' };
  }

  // WEBP: RIFF at 0..3 and WEBP at 8..11
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { valid: true, format: 'webp' };
  }

  return { valid: false };
}
