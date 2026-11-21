# Cloudinary Media Upload Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây dựng phân hệ tải và quản lý file media công khai qua Cloudinary cho Chủ trọ (ảnh bìa khu trọ và bộ ảnh phòng trọ với cơ chế Partial Success, dọn dẹp ảnh cũ/ảnh lỗi an toàn).

**Architecture:** Sử dụng kiến trúc Modular Monolith phân tầng. `src/modules/media/` đóng vai trò module dùng chung cung cấp Cloudinary stream upload (in-memory buffer qua Multer) và delete service; `src/common/utils/cloudinary.util.ts` quản lý việc sinh và trích xuất `public_id` từ URL (Zero DB Schema Drift); tích hợp trực tiếp vào Controller/Service của `properties` và `rooms` với cơ chế kiểm tra quyền sở hữu nghiêm ngặt và bù trừ lỗi (compensating cleanup).

**Tech Stack:** Express 5, TypeScript, Multer 1.4.x, Cloudinary SDK 2.x, Prisma 6.19.3, Node.js Test Runner (`node:test`).

**Spec:** [docs/superpowers/specs/2026-11-17-cloudinary-media-upload-design.md](file:///C:/Users/ADMIN/orca/workspaces/backend/staging/docs/superpowers/specs/2026-11-17-cloudinary-media-upload-design.md)

## Global Constraints

- Không chỉnh sửa `prisma/schema.prisma` và không chạy bất kỳ lệnh migration nào (Zero DB Schema Drift).
- Chỉ cho phép upload file qua memory buffer (RAM), tuyệt đối không lưu file tạm ra ổ đĩa máy chủ.
- Giới hạn kích thước file tối đa 5 MiB/ảnh; chỉ chấp nhận định dạng `image/jpeg`, `image/png`, `image/webp`.
- Giới hạn tối đa 10 ảnh cho mỗi phòng trọ (`RoomImage`).
- Cơ chế Anti-Enumeration: Trả về `404 NOT_FOUND` cho bất kỳ hành vi truy cập khu trọ/phòng trọ không thuộc quyền sở hữu của chủ trọ.
- Không để lộ Cloudinary API Secret trong source code, logs, commit diff hoặc response payload.
- Mọi thao tác bất đồng bộ tải/xóa ảnh ngoài Cloudinary nếu gặp lỗi phải có cơ chế bù trừ và log chi tiết.

## Review Focus

1. **Magic bytes validation mismatch:** Client gửi file có đuôi `.jpg` hoặc MIME header `image/jpeg` nhưng nội dung nhị phân bên trong là file thực thi hoặc script độc hại $\rightarrow$ Hàm kiểm tra nhị phân phải phát hiện và từ chối với lỗi `415 UNSUPPORTED_MEDIA_TYPE` trước khi gửi lên Cloudinary.
2. **Partial Success edge cases:** Chủ trọ gửi mảng 5 ảnh nhưng phòng chỉ còn trống 2 slot $\rightarrow$ 2 ảnh đầu tiên được xử lý, 3 ảnh sau phải lập tức vào mảng `failed` với lý do vượt quá số slot còn lại mà không tiêu tốn tài nguyên upload.
3. **Database update failure compensation:** Ảnh bìa/ảnh phòng đã upload thành công lên Cloudinary nhưng truy vấn Database (Prisma) bị lỗi mạng/timeout $\rightarrow$ Hệ thống phải lập tức gọi `cloudinary.uploader.destroy(newPublicId)` để xóa bù ảnh mồ côi trên Cloudinary, không để thất thoát dung lượng.
4. **Delete image ownership scoping:** Chủ trọ A cố tình gọi API xóa ảnh `imageId` nằm trong phòng của chủ trọ B $\rightarrow$ Hệ thống phải trả về `404 NOT_FOUND`, tuyệt đối không xóa dữ liệu trong DB hay Cloudinary.
5. **Deterministic publicId extraction:** Cloudinary URL chứa các biến thể (version `v1731...`, các tiền tố phụ, định dạng đuôi `.webp`/`.jpg`) $\rightarrow$ Hàm trích xuất phải lấy ra chính xác `public_id` để lệnh `destroy` trên Cloudinary thành công.

---

### Task 1: Cài đặt Dependencies & Khởi tạo Cloudinary Client

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Create: `src/infrastructure/cloudinary/cloudinary.client.ts`
- Test: `tests/media/cloudinary-client.test.ts`

**Interfaces:**
- Produces: `getCloudinaryClient(): typeof cloudinary.v2`

- [ ] **Step 1: Write the failing test for Cloudinary client configuration**

File: `tests/media/cloudinary-client.test.ts`
```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCloudinaryClient } from '../../src/infrastructure/cloudinary/cloudinary.client';

test('getCloudinaryClient returns configured cloudinary instance with environment variables', () => {
  process.env.CLOUDINARY_CLOUD_NAME = 'test_cloud';
  process.env.CLOUDINARY_API_KEY = 'test_key';
  process.env.CLOUDINARY_API_SECRET = 'test_secret';

  const client = getCloudinaryClient();
  assert.ok(client);
  const config = client.config();
  assert.equal(config.cloud_name, 'test_cloud');
  assert.equal(config.api_key, 'test_key');
  assert.equal(config.api_secret, 'test_secret');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/media/cloudinary-client.test.ts`  
Expected: FAIL (Cannot find module)

- [ ] **Step 3: Install dependencies `cloudinary` and `multer`, `@types/multer`**

Run: `npm install cloudinary multer && npm install -D @types/multer`

- [ ] **Step 4: Implement `getCloudinaryClient()` in `src/infrastructure/cloudinary/cloudinary.client.ts` and update `.env.example`**

Update `.env.example`:
```env
# Cloudinary Storage
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

File: `src/infrastructure/cloudinary/cloudinary.client.ts`:
```typescript
import { v2 as cloudinary } from 'cloudinary';

let isConfigured = false;

export function getCloudinaryClient(): typeof cloudinary {
  if (!isConfigured) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    isConfigured = true;
  }
  return cloudinary;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/media/cloudinary-client.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .env.example src/infrastructure/cloudinary/cloudinary.client.ts tests/media/cloudinary-client.test.ts
git commit -m "feat(media): install dependencies and configure Cloudinary client"
```

---

### Task 2: Cloudinary & Media Utilities (`cloudinary.util.ts`)

**Files:**
- Create: `src/common/utils/cloudinary.util.ts`
- Test: `tests/media/cloudinary-util.test.ts`

**Interfaces:**
- Produces:
  - `extractCloudinaryPublicId(url: string): string | null`
  - `buildPropertyCoverPublicId(propertyId: string): string`
  - `buildRoomImagePublicId(roomId: string, imageId: string): string`
  - `validateImageBufferMagicBytes(buffer: Buffer): { valid: boolean; format?: string }`

- [ ] **Step 1: Write the failing test for Cloudinary utilities**

File: `tests/media/cloudinary-util.test.ts`
```typescript
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  extractCloudinaryPublicId,
  buildPropertyCoverPublicId,
  buildRoomImagePublicId,
  validateImageBufferMagicBytes,
} from '../../src/common/utils/cloudinary.util';

describe('Cloudinary Utilities', () => {
  test('extractCloudinaryPublicId extracts publicId from standard Cloudinary URL', () => {
    const url = 'https://res.cloudinary.com/test-cloud/image/upload/v1731835000/rentmate/rooms/r-101/img-001.webp';
    const publicId = extractCloudinaryPublicId(url);
    assert.equal(publicId, 'rentmate/rooms/r-101/img-001');
  });

  test('extractCloudinaryPublicId returns null for non-cloudinary URL', () => {
    assert.equal(extractCloudinaryPublicId('https://example.com/avatar.png'), null);
    assert.equal(extractCloudinaryPublicId(''), null);
  });

  test('buildPropertyCoverPublicId creates structured path with prefix', () => {
    const publicId = buildPropertyCoverPublicId('prop-123');
    assert.ok(publicId.startsWith('rentmate/properties/prop-123/cover_'));
  });

  test('buildRoomImagePublicId creates structured path with room and image ids', () => {
    const publicId = buildRoomImagePublicId('room-123', 'img-456');
    assert.equal(publicId, 'rentmate/rooms/room-123/img-456');
  });

  test('validateImageBufferMagicBytes detects valid JPEG, PNG, WEBP', () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.equal(validateImageBufferMagicBytes(jpegBuffer).valid, true);
    assert.equal(validateImageBufferMagicBytes(jpegBuffer).format, 'jpeg');

    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(validateImageBufferMagicBytes(pngBuffer).valid, true);
    assert.equal(validateImageBufferMagicBytes(pngBuffer).format, 'png');

    const webpBuffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    assert.equal(validateImageBufferMagicBytes(webpBuffer).valid, true);
    assert.equal(validateImageBufferMagicBytes(webpBuffer).format, 'webp');

    const invalidBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    assert.equal(validateImageBufferMagicBytes(invalidBuffer).valid, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/media/cloudinary-util.test.ts`  
Expected: FAIL (Cannot find module)

- [ ] **Step 3: Implement utilities in `src/common/utils/cloudinary.util.ts`**

File: `src/common/utils/cloudinary.util.ts`:
- Triển khai `extractCloudinaryPublicId`: sử dụng regex trích xuất phần path sau `/upload/(v[0-9]+/)?` và bỏ đuôi mở rộng `.jpg|.png|.webp...`.
- Triển khai `buildPropertyCoverPublicId(propertyId)`: `rentmate/properties/${propertyId}/cover_${Date.now()}`.
- Triển khai `buildRoomImagePublicId(roomId, imageId)`: `rentmate/rooms/${roomId}/${imageId}`.
- Triển khai `validateImageBufferMagicBytes(buffer)`: kiểm tra magic bytes của JPEG (`FF D8 FF`), PNG (`89 50 4E 47`), WEBP (`RIFF....WEBP`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/media/cloudinary-util.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/common/utils/cloudinary.util.ts tests/media/cloudinary-util.test.ts
git commit -m "feat(media): implement Cloudinary URL parser and magic bytes validator utils"
```

---

### Task 3: Phân hệ Media dùng chung (Multer Middleware & MediaService)

**Files:**
- Create: `src/modules/media/media.types.ts`
- Create: `src/modules/media/media.middleware.ts`
- Create: `src/modules/media/media.service.ts`
- Test: `tests/media/media-service.test.ts`

**Interfaces:**
- Produces:
  - `uploadSingleImage(fieldName: string): RequestHandler`
  - `uploadMultipleImages(fieldName: string, maxCount: number): RequestHandler`
  - `MediaService.uploadStream(buffer: Buffer, options: { publicId: string; folder?: string }): Promise<{ secureUrl: string; publicId: string }>`
  - `MediaService.deleteResource(publicId: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test for `MediaService`**

File: `tests/media/media-service.test.ts`
```typescript
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { getCloudinaryClient } from '../../src/infrastructure/cloudinary/cloudinary.client';
import { MediaService } from '../../src/modules/media/media.service';

const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => { delegate[name] = original; });
}

describe('MediaService', () => {
  test('uploadStream successfully streams buffer and resolves with secure_url', async () => {
    const client = getCloudinaryClient();
    stub(client.uploader, 'upload_stream', (options: any, callback: any) => {
      return {
        end: (buf: Buffer) => {
          callback(null, {
            secure_url: 'https://res.cloudinary.com/test/image/upload/v1/rentmate/test.jpg',
            public_id: options.public_id,
          });
        },
      };
    });

    const result = await MediaService.uploadStream(Buffer.from('fake-image-data'), {
      publicId: 'rentmate/test',
    });

    assert.equal(result.secureUrl, 'https://res.cloudinary.com/test/image/upload/v1/rentmate/test.jpg');
    assert.equal(result.publicId, 'rentmate/test');
  });

  test('deleteResource calls cloudinary destroy and returns true on success', async () => {
    const client = getCloudinaryClient();
    stub(client.uploader, 'destroy', async (publicId: string) => {
      assert.equal(publicId, 'rentmate/test');
      return { result: 'ok' };
    });

    const success = await MediaService.deleteResource('rentmate/test');
    assert.equal(success, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/media/media-service.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement types, middleware, and service in `src/modules/media/`**

1. `src/modules/media/media.types.ts`: Định nghĩa `CloudinaryUploadResult`, `CloudinaryUploadOptions`.
2. `src/modules/media/media.middleware.ts`:
   - Cấu hình Multer `memoryStorage()`.
   - `limits: { fileSize: 5 * 1024 * 1024 }` (5 MiB).
   - `fileFilter`: Kiểm tra `mimetype` (`image/jpeg`, `image/png`, `image/webp`). Ném `ApiError(415, 'UNSUPPORTED_MEDIA_TYPE')` nếu sai.
   - Bắt lỗi Multer `LIMIT_FILE_SIZE` và chuyển thành `ApiError(413, 'PAYLOAD_TOO_LARGE', 'Dung lượng ảnh vượt quá giới hạn cho phép (5 MiB)')`.
3. `src/modules/media/media.service.ts`:
   - `uploadStream`: Wrap `upload_stream` trong `new Promise(...)`.
   - `deleteResource`: Gọi `client.uploader.destroy(publicId)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/media/media-service.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/media/ tests/media/media-service.test.ts
git commit -m "feat(media): implement multer memory storage middleware and Cloudinary stream service"
```

---

### Task 4: API Upload / Thay thế ảnh bìa khu trọ (`POST /properties/:propertyId/cover-image`)

**Files:**
- Modify: `src/modules/properties/property.repository.ts`
- Modify: `src/modules/properties/property.service.ts`
- Modify: `src/modules/properties/property.controller.ts`
- Modify: `src/modules/properties/property.routes.ts`
- Test: `tests/properties/property-cover-image.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/v1/landlord/properties/:propertyId/cover-image`
  - Response: `{ success: true, propertyId: string, coverImageUrl: string }`

- [ ] **Step 1: Write integration tests for property cover image upload**

File: `tests/properties/property-cover-image.test.ts`
```typescript
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { prisma } from '../../src/infrastructure/database/prisma';
import { MediaService } from '../../src/modules/media/media.service';
import { PropertyService } from '../../src/modules/properties/property.service';

const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => { delegate[name] = original; });
}

const mockLandlordId = '550e8400-e29b-41d4-a716-446655440001';
const otherLandlordId = '550e8400-e29b-41d4-a716-446655440099';
const mockPropertyId = '550e8400-e29b-41d4-a716-446655440002';

describe('Property Cover Image Upload', () => {
  test('rejects with 404 when property is owned by another landlord (Anti-Enumeration)', async () => {
    stub(prisma.property, 'findUnique', async () => ({
      id: mockPropertyId,
      landlordId: otherLandlordId,
      coverImageUrl: null,
    }));

    await assert.rejects(
      () => PropertyService.updateCoverImage(mockLandlordId, mockPropertyId, {
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        mimetype: 'image/jpeg',
      } as any),
      (err: any) => err.statusCode === 404 && err.code === 'PROPERTY_NOT_FOUND',
    );
  });

  test('successfully uploads cover image, updates DB, and triggers background deletion of old cover', async () => {
    stub(prisma.property, 'findUnique', async () => ({
      id: mockPropertyId,
      landlordId: mockLandlordId,
      coverImageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/rentmate/properties/prop-1/old_cover.jpg',
    }));

    let deletedOldPublicId: string | null = null;
    stub(MediaService, 'deleteResource', async (pid: string) => {
      deletedOldPublicId = pid;
      return true;
    });

    stub(MediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v1/rentmate/properties/prop-1/new_cover.jpg',
      publicId: 'rentmate/properties/prop-1/new_cover',
    }));

    stub(prisma.property, 'update', async ({ where, data }: any) => {
      assert.equal(where.id, mockPropertyId);
      assert.equal(data.coverImageUrl, 'https://res.cloudinary.com/demo/image/upload/v1/rentmate/properties/prop-1/new_cover.jpg');
      return { id: mockPropertyId, coverImageUrl: data.coverImageUrl };
    });

    const result = await PropertyService.updateCoverImage(mockLandlordId, mockPropertyId, {
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      mimetype: 'image/jpeg',
    } as any);

    assert.equal(result.success, true);
    assert.equal(result.coverImageUrl, 'https://res.cloudinary.com/demo/image/upload/v1/rentmate/properties/prop-1/new_cover.jpg');
    assert.equal(deletedOldPublicId, 'rentmate/properties/prop-1/old_cover');
  });

  test('deletes newly uploaded image from Cloudinary if DB update fails (Compensating action)', async () => {
    stub(prisma.property, 'findUnique', async () => ({
      id: mockPropertyId,
      landlordId: mockLandlordId,
      coverImageUrl: null,
    }));

    let compensatedPublicId: string | null = null;
    stub(MediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v1/new.jpg',
      publicId: 'rentmate/properties/prop-1/new',
    }));
    stub(MediaService, 'deleteResource', async (pid: string) => {
      compensatedPublicId = pid;
      return true;
    });
    stub(prisma.property, 'update', async () => {
      throw new Error('Database connection failed');
    });

    await assert.rejects(
      () => PropertyService.updateCoverImage(mockLandlordId, mockPropertyId, {
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        mimetype: 'image/jpeg',
      } as any),
      (err: any) => err.statusCode === 500,
    );

    assert.equal(compensatedPublicId, 'rentmate/properties/prop-1/new');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/properties/property-cover-image.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement `updateCoverImage` logic in Property module**

1. In `src/modules/properties/property.repository.ts`: Thêm `updateCoverImage(propertyId: string, coverImageUrl: string)`.
2. In `src/modules/properties/property.service.ts`: Thêm `updateCoverImage(landlordId, propertyId, file)`.
   - Validate magic bytes.
   - Verify ownership (`landlordId`).
   - Upload new image qua `MediaService.uploadStream`.
   - Update DB qua repository.
   - Try-catch rollback xóa bù ảnh mới nếu DB lỗi.
   - Cleanup ảnh cũ trên Cloudinary nếu thành công.
3. In `src/modules/properties/property.controller.ts`: Thêm action `uploadCoverImage`.
4. In `src/modules/properties/property.routes.ts`: Đăng ký `router.post('/:propertyId/cover-image', authenticateToken, requireRole('LANDLORD'), uploadSingleImage('coverImage'), PropertyController.uploadCoverImage)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/properties/property-cover-image.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/properties/ tests/properties/property-cover-image.test.ts
git commit -m "feat(properties): implement property cover image upload with Cloudinary and cleanup"
```

---

### Task 5: API Upload nhiều ảnh phòng trọ với Partial Success (`POST /rooms/:roomId/images`)

**Files:**
- Modify: `src/modules/rooms/room-management.repository.ts`
- Modify: `src/modules/rooms/room-management.service.ts`
- Modify: `src/modules/rooms/room-management.controller.ts`
- Modify: `src/modules/rooms/room-management.routes.ts`
- Test: `tests/rooms/room-images-upload.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/v1/landlord/rooms/:roomId/images`
  - Response: `BatchRoomImageUploadResponse`

- [ ] **Step 1: Write integration tests for batch room image upload with Partial Success**

File: `tests/rooms/room-images-upload.test.ts`
```typescript
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { prisma } from '../../src/infrastructure/database/prisma';
import { MediaService } from '../../src/modules/media/media.service';
import { RoomManagementService } from '../../src/modules/rooms/room-management.service';

const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => { delegate[name] = original; });
}

const mockLandlordId = '550e8400-e29b-41d4-a716-446655440001';
const mockRoomId = '550e8400-e29b-41d4-a716-446655440003';

describe('Room Images Batch Upload', () => {
  test('rejects with 400 when room already reached 10 images limit', async () => {
    stub(prisma.room, 'findUnique', async () => ({
      id: mockRoomId,
      property: { landlordId: mockLandlordId },
    }));
    stub(prisma.roomImage, 'count', async () => 10);

    await assert.rejects(
      () => RoomManagementService.uploadRoomImages(mockLandlordId, mockRoomId, [{
        originalname: 'img.jpg',
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        mimetype: 'image/jpeg',
      }] as any),
      (err: any) => err.statusCode === 400 && err.code === 'ROOM_IMAGE_LIMIT_EXCEEDED',
    );
  });

  test('processes partial success: 1 valid image succeeds and 1 invalid image fails with detailed report', async () => {
    stub(prisma.room, 'findUnique', async () => ({
      id: mockRoomId,
      property: { landlordId: mockLandlordId },
    }));
    stub(prisma.roomImage, 'count', async () => 8); // 2 slots remaining
    stub(prisma.roomImage, 'findFirst', async () => ({ sortOrder: 8 })); // max sortOrder

    stub(MediaService, 'uploadStream', async () => ({
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/v1/rentmate/rooms/r1/img1.jpg',
      publicId: 'rentmate/rooms/r1/img1',
    }));

    stub(prisma.roomImage, 'create', async ({ data }: any) => ({
      id: 'img-uuid-1',
      ...data,
      createdAt: new Date(),
    }));

    const files = [
      { originalname: 'valid.jpg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mimetype: 'image/jpeg' },
      { originalname: 'corrupt.jpg', buffer: Buffer.from([0x00, 0x00]), mimetype: 'image/jpeg' }, // invalid magic bytes
    ] as any;

    const result = await RoomManagementService.uploadRoomImages(mockLandlordId, mockRoomId, files);

    assert.equal(result.success, true);
    assert.equal(result.summary.totalRequested, 2);
    assert.equal(result.summary.succeeded, 1);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.uploaded.length, 1);
    assert.equal(result.uploaded[0].imageUrl, 'https://res.cloudinary.com/demo/image/upload/v1/rentmate/rooms/r1/img1.jpg');
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].originalName, 'corrupt.jpg');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/rooms/room-images-upload.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement batch upload with Partial Success in Room Management module**

1. In `src/modules/rooms/room-management.repository.ts`:
   - Thêm `countRoomImages(roomId: string): Promise<number>`.
   - Thêm `getMaxSortOrder(roomId: string): Promise<number>`.
   - Thêm `createRoomImage(roomId: string, imageUrl: string, sortOrder: number)`.
2. In `src/modules/rooms/room-management.service.ts`:
   - Triển khai `uploadRoomImages(landlordId, roomId, files)`.
   - Check ownership và room status.
   - Tính remaining slots (`10 - count`).
   - Lặp qua files, phân loại `failed` vs `uploaded`.
   - Gọi `MediaService.uploadStream` và `createRoomImage`.
3. In `src/modules/rooms/room-management.controller.ts`:
   - Thêm action `uploadImages`: Trả về `201` nếu toàn bộ thành công, `200` nếu partial success, `400` nếu toàn bộ thất bại.
4. In `src/modules/rooms/room-management.routes.ts`:
   - Đăng ký `POST /:roomId/images` với middleware `uploadMultipleImages('images', 10)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/rooms/room-images-upload.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/rooms/ tests/rooms/room-images-upload.test.ts
git commit -m "feat(rooms): implement batch room images upload with Partial Success support"
```

---

### Task 6: API Xóa ảnh phòng trọ (`DELETE /rooms/:roomId/images/:imageId`)

**Files:**
- Modify: `src/modules/rooms/room-management.repository.ts`
- Modify: `src/modules/rooms/room-management.service.ts`
- Modify: `src/modules/rooms/room-management.controller.ts`
- Modify: `src/modules/rooms/room-management.routes.ts`
- Test: `tests/rooms/room-images-delete.test.ts`

**Interfaces:**
- Produces:
  - `DELETE /api/v1/landlord/rooms/:roomId/images/:imageId`
  - Response: `{ success: true, message: string }`

- [ ] **Step 1: Write integration tests for room image deletion**

File: `tests/rooms/room-images-delete.test.ts`
```typescript
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { prisma } from '../../src/infrastructure/database/prisma';
import { MediaService } from '../../src/modules/media/media.service';
import { RoomManagementService } from '../../src/modules/rooms/room-management.service';

const undo: Array<() => void> = [];
afterEach(() => { while (undo.length) undo.pop()!(); });

function stub(delegate: any, name: string, implementation: (...args: any[]) => any) {
  const original = delegate[name];
  delegate[name] = implementation;
  undo.push(() => { delegate[name] = original; });
}

const mockLandlordId = '550e8400-e29b-41d4-a716-446655440001';
const mockRoomId = '550e8400-e29b-41d4-a716-446655440003';
const mockImageId = '550e8400-e29b-41d4-a716-446655440004';

describe('Room Image Deletion', () => {
  test('rejects with 404 when image is not found in the room', async () => {
    stub(prisma.room, 'findUnique', async () => ({
      id: mockRoomId,
      property: { landlordId: mockLandlordId },
    }));
    stub(prisma.roomImage, 'findFirst', async () => null);

    await assert.rejects(
      () => RoomManagementService.deleteRoomImage(mockLandlordId, mockRoomId, mockImageId),
      (err: any) => err.statusCode === 404 && err.code === 'IMAGE_NOT_FOUND',
    );
  });

  test('successfully deletes room image from DB and Cloudinary', async () => {
    stub(prisma.room, 'findUnique', async () => ({
      id: mockRoomId,
      property: { landlordId: mockLandlordId },
    }));
    stub(prisma.roomImage, 'findFirst', async () => ({
      id: mockImageId,
      roomId: mockRoomId,
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/rentmate/rooms/r1/img-1.jpg',
    }));

    let deletedDbId: string | null = null;
    stub(prisma.roomImage, 'delete', async ({ where }: any) => {
      deletedDbId = where.id;
      return { id: mockImageId };
    });

    let destroyedPublicId: string | null = null;
    stub(MediaService, 'deleteResource', async (pid: string) => {
      destroyedPublicId = pid;
      return true;
    });

    const result = await RoomManagementService.deleteRoomImage(mockLandlordId, mockRoomId, mockImageId);

    assert.equal(result.success, true);
    assert.equal(deletedDbId, mockImageId);
    assert.equal(destroyedPublicId, 'rentmate/rooms/r1/img-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/rooms/room-images-delete.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement deletion logic in Room Management module**

1. In `src/modules/rooms/room-management.repository.ts`:
   - Thêm `findRoomImage(roomId: string, imageId: string)`.
   - Thêm `deleteRoomImage(imageId: string)`.
2. In `src/modules/rooms/room-management.service.ts`:
   - Triển khai `deleteRoomImage(landlordId, roomId, imageId)`.
   - Check ownership.
   - Xóa DB trước.
   - Trích xuất `public_id` và gọi `MediaService.deleteResource`.
3. In `src/modules/rooms/room-management.controller.ts`:
   - Thêm action `deleteImage`.
4. In `src/modules/rooms/room-management.routes.ts`:
   - Đăng ký `DELETE /:roomId/images/:imageId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/rooms/room-images-delete.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/rooms/ tests/rooms/room-images-delete.test.ts
git commit -m "feat(rooms): implement room image deletion from database and Cloudinary"
```

---

### Task 7: Tài liệu OpenAPI 3.1 & Kiểm thử xác minh toàn diện

**Files:**
- Create: `docs/openapi/media-uploads.yaml`
- Modify: `docs/openapi/property-management.yaml`
- Modify: `docs/openapi/room-management.yaml`

- [ ] **Step 1: Write OpenAPI 3.1 specification for media upload endpoints**

File `docs/openapi/media-uploads.yaml`:
Mô tả chi tiết 3 endpoints:
- `POST /api/v1/landlord/properties/{propertyId}/cover-image`
- `POST /api/v1/landlord/rooms/{roomId}/images`
- `DELETE /api/v1/landlord/rooms/{roomId}/images/{imageId}`
Bao gồm đầy đủ payload schemas, MIME `multipart/form-data`, responses `200`, `201`, `400`, `401`, `403`, `404`, `413`, `415`, `500`.

- [ ] **Step 2: Run strict TypeScript typecheck**

Run: `npm run typecheck`  
Expected: 0 errors (`tsc --noEmit`)

- [ ] **Step 3: Run project build**

Run: `npm run build`  
Expected: 0 errors

- [ ] **Step 4: Run the complete test suite**

Run: `npm test`  
Expected: ALL test suites PASS (including all existing 224 tests + new media tests)

- [ ] **Step 5: Commit OpenAPI specs and final verification**

```bash
git add docs/openapi/
git commit -m "docs(api): add OpenAPI 3.1 specifications for Cloudinary media upload endpoints"
```
