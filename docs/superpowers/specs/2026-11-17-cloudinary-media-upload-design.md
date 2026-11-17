# Technical Design Specification: Cloudinary Media Upload Integration

**Issue:** #16 ([BE-P2-03] Tích hợp Cloudinary để tải ảnh khu trọ và phòng trọ)  
**Tác giả:** @phangiadat  
**Ngày:** 2026-11-17  
**Nhánh:** `feat/p2-03-cloudinary-upload`  
**Trạng thái:** DRAFT (Chờ phê duyệt)  

---

## 1. Mục tiêu nghiệp vụ (Business Goals)

Cung cấp giải pháp lưu trữ và quản lý ảnh công khai toàn diện cho Chủ trọ (Landlord) trong hệ thống RentMate:
1. **Ảnh bìa khu trọ (`Property.coverImageUrl`):** Cho phép upload hoặc thay thế ảnh bìa đại diện cho khu trọ thuộc quyền sở hữu của chủ trọ, tự động dọn dẹp ảnh bìa cũ trên Cloudinary để giải phóng dung lượng.
2. **Bộ sưu tập ảnh phòng trọ (`RoomImage`):** Cho phép upload hàng loạt (batch) nhiều ảnh cùng lúc cho phòng trọ với cơ chế **Partial Success** (thành công một phần), đảm bảo giới hạn tối đa 10 ảnh/phòng và sắp xếp theo thứ tự `sortOrder ASC, id ASC`.
3. **Xóa ảnh phòng trọ:** Cho phép chủ trọ xóa an toàn ảnh phòng trọ cả trong Database và xóa tài nguyên file nhị phân tương ứng trên Cloudinary.
4. **Phân hệ dùng chung (Shared Media Subsystem):** Thiết kế `src/modules/media/` độc lập, tái sử dụng được cho các tính năng khác trong tương lai (ảnh chụp điện nước, hiện trạng bàn giao, báo hỏng sự cố...).

---

## 2. Ranh giới kiến trúc & Nguyên tắc cốt lõi (Core Principles)

1. **Zero DB Schema Drift:**
   - Tuyệt đối không chỉnh sửa `prisma/schema.prisma` và không chạy migration CSDL mới.
   - Bảng `properties` sử dụng cột có sẵn `coverImageUrl: String?`.
   - Bảng `room_images` sử dụng cột có sẵn `id: UUID`, `roomId: UUID`, `imageUrl: String`, `sortOrder: Int`.
   - Định danh `public_id` của Cloudinary được đặt theo cấu trúc chuẩn xác định và được trích xuất từ URL bằng hàm tiện ích (`cloudinary.util.ts`) khi cần xóa.
2. **Streaming qua Memory Buffer (RAM):**
   - Sử dụng `multer.memoryStorage()` kết hợp `cloudinary.uploader.upload_stream()`.
   - Không bao giờ ghi file tạm xuống ổ cứng server để đảm bảo an toàn, hiệu năng cao và tương thích môi trường Container/Serverless.
3. **Bảo mật & Quyền sở hữu (Ownership & Anti-Enumeration):**
   - Kiểm tra quyền sở hữu khu trọ / phòng trọ trước khi thực hiện bất kỳ thao tác upload hoặc xóa ảnh nào.
   - Nếu tài nguyên không tồn tại hoặc thuộc chủ trọ khác: Trả về `404 NOT_FOUND` để chống dò quét ID.
   - Kiểm tra MIME type và magic bytes của file nhị phân (chỉ chấp nhận `image/jpeg`, `image/png`, `image/webp`). Giới hạn dung lượng tối đa **5 MiB/ảnh**.
4. **Cơ chế bù trừ lỗi (Compensating Actions):**
   - Nếu Cloudinary upload thành công nhưng cập nhật Database thất bại: Tự động kích hoạt hàm xóa bù file vừa upload trên Cloudinary để tránh rác lưu trữ.
   - Khi thay thế ảnh bìa: Chỉ xóa ảnh cũ trên Cloudinary sau khi giao dịch cập nhật ảnh mới vào Database đã thành công trọn vẹn.

---

## 3. Danh sách Endpoints API

| Phương thức | Endpoint | Input (Content-Type) | Output thành công | Mục đích |
|---|---|---|---|---|
| **POST** | `/api/v1/landlord/properties/:propertyId/cover-image` | `multipart/form-data`<br>Field: `coverImage` (1 file, $\le 5$ MiB) | `200 OK`<br>`{ success: true, coverImageUrl: string }` | Upload hoặc thay thế ảnh bìa khu trọ |
| **POST** | `/api/v1/landlord/rooms/:roomId/images` | `multipart/form-data`<br>Field: `images` (Mảng file, tối đa slot còn lại) | `200 OK` (Partial) / `201 Created` (100%)<br>`BatchUploadResponse` | Upload nhiều ảnh cho phòng (Partial Success) |
| **DELETE** | `/api/v1/landlord/rooms/:roomId/images/:imageId` | URL Params | `200 OK`<br>`{ success: true, message: string }` | Xóa an toàn 1 ảnh phòng trọ (DB & Cloudinary) |

---

## 4. Cấu trúc thư mục & Phân định trách nhiệm

```
src/
├── common/
│   └── utils/
│       └── cloudinary.util.ts        # Tiện ích parse URL, trích xuất public_id, build folder path, validate magic bytes
├── infrastructure/
│   └── cloudinary/
│       └── cloudinary.client.ts      # Singleton Cloudinary SDK client cấu hình từ .env
└── modules/
    ├── media/
    │   ├── media.types.ts            # Type definitions, Cloudinary upload/delete options & responses
    │   ├── media.middleware.ts       # Multer memoryStorage configuration, fileFilter, size limits
    │   └── media.service.ts          # Core service: uploadStreamToCloudinary, deleteCloudinaryResource
    ├── properties/
    │   ├── property.controller.ts    # Thêm action uploadCoverImage
    │   ├── property.service.ts       # Thêm logic uploadCoverImage & cleanup ảnh cũ
    │   └── property.routes.ts        # Đăng ký route POST /:propertyId/cover-image
    └── rooms/
        ├── room-management.controller.ts # Thêm action uploadRoomImages & deleteRoomImage
        ├── room-management.service.ts    # Thêm logic uploadRoomImages (partial success) & deleteRoomImage
        ├── room-management.repository.ts # Thêm DB queries: đếm ảnh phòng, thêm ảnh, xóa ảnh
        └── room-management.routes.ts     # Đăng ký routes POST /:roomId/images & DELETE /:roomId/images/:imageId
```

---

## 5. Chi tiết thiết kế Data Contracts & DTOs

### 5.1. Response Upload Ảnh bìa Khu trọ
```typescript
export interface PropertyCoverImageResponse {
  success: boolean;
  propertyId: string;
  coverImageUrl: string;
}
```

### 5.2. Response Batch Upload Ảnh phòng trọ ("Partial Success")
```typescript
export interface UploadedRoomImageItem {
  id: string;
  roomId: string;
  imageUrl: string;
  sortOrder: number;
  createdAt: string;
}

export interface FailedRoomImageItem {
  originalName: string;
  reason: string;
}

export interface BatchRoomImageUploadResponse {
  success: boolean;
  summary: {
    totalRequested: number;
    succeeded: number;
    failed: number;
    remainingSlots: number;
  };
  uploaded: UploadedRoomImageItem[];
  failed: FailedRoomImageItem[];
}
```

### 5.3. Định dạng `public_id` có quy tắc (Deterministic Public ID)
- Ảnh bìa khu trọ: `rentmate/properties/{propertyId}/cover_{timestamp}`
- Ảnh phòng trọ: `rentmate/rooms/{roomId}/{uuid}`

### 5.4. Quy tắc trích xuất `public_id` từ Cloudinary URL
Ví dụ URL: `https://res.cloudinary.com/rentmate-cloud/image/upload/v1731835000/rentmate/rooms/r-101/img-001.webp`  
Hàm `extractCloudinaryPublicId(url)` loại bỏ domain, tiền tố `/image/upload/`, bỏ chuỗi version `v[0-9]+/`, và bỏ phần mở rộng `.webp` $\rightarrow$ Trích xuất được chính xác: `rentmate/rooms/r-101/img-001`.

---

## 6. Luồng xử lý chi tiết (Detailed Workflows)

### 6.1. Upload ảnh bìa khu trọ (`POST /properties/:propertyId/cover-image`)
1. Middleware `authenticateToken`, `requireRole('LANDLORD')`.
2. Middleware `uploadSingleImage('coverImage')` nhận file vào `req.file.buffer`.
3. Kiểm tra quyền sở hữu khu trọ: `property.landlordId === currentUser.id`. Nếu sai $\rightarrow$ `404 NOT_FOUND`.
4. Ghi nhận `oldCoverImageUrl = property.coverImageUrl`.
5. Tạo `publicId = buildPropertyCoverPublicId(propertyId)`.
6. Gọi `MediaService.uploadStream(req.file.buffer, { folder, publicId })` $\rightarrow$ nhận về `newImageUrl`.
7. Cập nhật `Property.coverImageUrl = newImageUrl` trong Database:
   - Nếu cập nhật Database **thất bại**: Gọi ngay `MediaService.deleteResource(publicId)` để xóa bù ảnh mới vừa tải lên Cloudinary $\rightarrow$ ném lỗi 500.
   - Nếu cập nhật Database **thành công**: Nếu `oldCoverImageUrl` tồn tại và là link Cloudinary, gọi hàm xóa ảnh cũ ngầm trong background (best-effort, không chặn response).
8. Trả về `200 OK` kèm `coverImageUrl`.

### 6.2. Upload nhiều ảnh phòng trọ (`POST /rooms/:roomId/images`)
1. Middleware `authenticateToken`, `requireRole('LANDLORD')`.
2. Middleware `uploadMultipleImages('images', 10)`.
3. Kiểm tra quyền sở hữu phòng trọ: `room.property.landlordId === currentUser.id`. Nếu sai $\rightarrow$ `404 NOT_FOUND`.
4. Đếm số lượng ảnh hiện có của phòng: `currentCount = await RoomManagementRepository.countRoomImages(roomId)`.
5. Tính số slot trống còn lại: `remainingSlots = 10 - currentCount`.
   - Nếu `remainingSlots <= 0`: Ném lỗi `400 ROOM_IMAGE_LIMIT_EXCEEDED` ("Phòng trọ đã đạt giới hạn tối đa 10 ảnh").
6. Khởi tạo mảng `uploaded: []` và `failed: []`.
7. Lấy danh sách file cần xử lý: `filesToProcess = req.files.slice(0, remainingSlots)`. Các file vượt quá `remainingSlots` được đưa ngay vào mảng `failed` với lý do *"Vượt quá số lượng ảnh còn lại của phòng"*.
8. Lặp qua từng file trong `filesToProcess`:
   - Xác thực file (kích thước $\le 5$ MiB, magic bytes nhị phân hợp lệ). Nếu không hợp lệ $\rightarrow$ đưa vào `failed`.
   - Sinh `imageId = uuidv4()`.
   - Tạo `publicId = buildRoomImagePublicId(roomId, imageId)`.
   - Stream file lên Cloudinary. Nếu Cloudinary lỗi $\rightarrow$ đưa vào `failed`.
   - Nếu Cloudinary thành công: Lưu bản ghi vào bảng `room_images` với `sortOrder = currentMaxSortOrder + 1`. Nếu DB insert lỗi $\rightarrow$ xóa bù ảnh trên Cloudinary và đưa vào `failed`.
   - Nếu cả 2 thành công $\rightarrow$ đưa vào `uploaded`.
9. Mã HTTP trả về:
   - Nếu `uploaded.length === 0`: Trả về `400 BAD_REQUEST` nếu mọi file đều lỗi.
   - Nếu `uploaded.length === req.files.length`: Trả về `201 CREATED`.
   - Nếu thành công một phần: Trả về `200 OK` kèm đầy đủ `summary`, `uploaded`, `failed`.

### 6.3. Xóa ảnh phòng trọ (`DELETE /rooms/:roomId/images/:imageId`)
1. Middleware `authenticateToken`, `requireRole('LANDLORD')`.
2. Kiểm tra phòng tồn tại và thuộc quyền sở hữu của chủ trọ. Nếu sai $\rightarrow$ `404 NOT_FOUND`.
3. Tìm ảnh `RoomImage` theo `id = imageId` và `roomId = roomId`. Nếu không thấy $\rightarrow$ `404 IMAGE_NOT_FOUND`.
4. Trích xuất `publicId = extractCloudinaryPublicId(image.imageUrl)`.
5. Xóa bản ghi trong Database trước: `await RoomManagementRepository.deleteRoomImage(imageId)`.
6. Nếu xóa DB thành công: Gọi `MediaService.deleteResource(publicId)` trên Cloudinary.
7. Trả về `200 OK` (`{ success: true, message: "Xóa ảnh thành công" }`).

---

## 7. Kế hoạch kiểm thử (Test Plan)

1. **Unit Tests cho Utilities (`tests/media/cloudinary-util.test.ts`):**
   - Trích xuất chính xác `public_id` từ nhiều dạng URL Cloudinary (có version, không version, có thư mục lồng nhau, định dạng webp/jpg/png).
   - Trả về `null` cho các URL không hợp lệ hoặc không phải của Cloudinary.
   - Kiểm tra magic bytes nhận diện đúng JPEG, PNG, WebP và từ chối file giả mạo đuôi.
2. **Unit Tests cho Media Service & Middleware (`tests/media/media-service.test.ts`):**
   - Mock Cloudinary SDK uploader stream: test trường hợp upload thành công, trường hợp Cloudinary trả lỗi timeout / quota.
   - Test hàm `deleteResource` xử lý `result: 'ok'` và `result: 'not found'`.
   - Test multer middleware: từ chối file $> 5$ MiB với `LIMIT_FILE_SIZE`, từ chối file lạ.
3. **Integration Tests cho Property Cover Image (`tests/properties/property-cover-image.test.ts`):**
   - Test 401 khi không đăng nhập.
   - Test 403 khi Tenant cố tình upload ảnh bìa.
   - Test 404 Anti-Enumeration khi upload ảnh bìa cho khu trọ của chủ trọ khác.
   - Test 200 OK khi upload thành công và xác nhận URL được cập nhật.
   - Test rollback xóa bù ảnh mới trên Cloudinary khi DB update lỗi.
4. **Integration Tests cho Room Images Upload & Delete (`tests/rooms/room-images.test.ts`):**
   - Test upload 1 ảnh và batch nhiều ảnh.
   - Test Partial Success: 2 ảnh hợp lệ, 1 ảnh lỗi kích thước $\rightarrow$ 2 ảnh được lưu, 1 ảnh báo lỗi trong payload.
   - Test chặn khi phòng đã đủ 10 ảnh (`ROOM_IMAGE_LIMIT_EXCEEDED`).
   - Test DELETE ảnh phòng: xóa thành công cả trong DB và gọi lệnh destroy trên Cloudinary.
   - Test xóa ảnh thuộc phòng khác $\rightarrow$ 404 NOT_FOUND.

---

## 8. OpenAPI Specification

Tạo tài liệu đặc tả chuẩn OpenAPI 3.1 tại: `docs/openapi/media-uploads.yaml` mô tả chi tiết:
- Schema `multipart/form-data` cho `coverImage` và `images`.
- Các mã response: `200`, `201`, `400`, `401`, `403`, `404`, `413` (Payload Too Large), `415` (Unsupported Media Type), `500`.
- Cập nhật liên kết vào tài liệu `docs/openapi/room-management.yaml` và `docs/openapi/property-management.yaml`.
