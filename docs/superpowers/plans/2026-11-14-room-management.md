# [BE-P2-02] Room Management & Public API Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai hoàn chỉnh phân hệ Quản lý phòng trọ cho Chủ trọ (8 endpoints CRUD, Visibility, Status transitions) và chuẩn hóa Public API xem chi tiết phòng theo GitHub Issue #15 (BE-P2-02).

**Architecture:** Sử dụng kiến trúc Sub-controller & Sub-service bên trong module `src/modules/rooms/`. Phân tách rạch ròi giữa luồng công khai (Room Discovery) và luồng nội bộ chủ trọ (Room Management). Luồng xử lý phân tầng nghiêm ngặt: `Router -> Controller -> Service -> Repository -> Prisma Client`.

**Tech Stack:** Express 5.3.0, Prisma Client 6.19.3, PostgreSQL, Node.js 24, TypeScript (CommonJS), Zod 4.6.7, Node.js native test runner (`node:test`, `node:assert`).

**Spec:** `docs/superpowers/specs/2026-11-14-room-management-design.md`

## Global Constraints

- **CommonJS Module:** Giữ nguyên `"module": "CommonJS"` trong `tsconfig.json`. Không chuyển sang ESM.
- **Prisma Client Singleton:** Chỉ sử dụng singleton export từ `src/infrastructure/database/prisma.ts`. Không khởi tạo `new PrismaClient()`.
- **Phân định trách nhiệm:** Service tuyệt đối không import Prisma Client hay gọi truy vấn Prisma trực tiếp (`tests/service.test.ts` kiểm tra điều này). Mọi truy vấn DB phải đi qua Repository.
- **Bảo mật dữ liệu:** Tuyệt đối không để lộ `passwordHash`, `password_hash`, hoặc thông tin nhạy cảm của người dùng trong bất kỳ API response nào.
- **Phê duyệt Migration:** Cấm tự tiện chạy `prisma migrate dev` khi chưa có sự phê duyệt rõ ràng từ người dùng.
- **Ranh giới an toàn Git:** Không tự ý `git commit` hay `git push` ngoài chỉ thị rõ ràng.

## Review Focus

1. **Từ chối chuyển trạng thái bất hợp lệ:** Kiểm tra payload yêu cầu chuyển `occupancyStatus` sang `HELD` hoặc `RENTED` phải bị từ chối với mã lỗi `409 Conflict`.
2. **Side-effect khi bảo trì:** Kiểm tra khi chuyển `occupancyStatus` sang `MAINTENANCE`, `visibilityStatus` bắt buộc phải tự động chuyển thành `HIDDEN`.
3. **Quy tắc 5 điều kiện hiển thị:** Kiểm tra bật `VISIBLE` sẽ bị từ chối nếu phòng đang `MAINTENANCE`, bị `isArchived`, hoặc khu trọ/chủ trọ bị khóa `INACTIVE`.
4. **Kiểm tra quyền sở hữu (Ownership check):** Chủ trọ không thể xem, sửa hoặc đổi trạng thái của phòng thuộc khu trọ do chủ trọ khác sở hữu (`403 Forbidden` hoặc `404 Not Found`).
5. **Thứ tự ưu tiên Route:** Đăng ký `/api/v1/rooms/search` trước `/api/v1/rooms/:roomId` trong Express Router để tránh Express hiểu nhầm chuỗi "search" là một `roomId`.

---

## Danh sách Tác vụ (Task Breakdown)

### Task 1: Đặc tả OpenAPI Specification & Cập nhật Public Contract

**Files:**
- Create: `docs/openapi/room-management.yaml`
- Modify: `docs/openapi/room-discovery.yaml`

**Interfaces:**
- Produces: File OpenAPI 3.1 hoàn chỉnh định nghĩa schema cho 6 endpoints chủ trọ, và cập nhật 2 URL public `/api/v1/rooms/{roomId}` (canonical) & `/api/v1/public/rooms/{roomId}` (deprecated).

- [x] **Step 1: Viết `docs/openapi/room-management.yaml`**
  - Khai báo các đường dẫn:
    - `POST /api/v1/landlord/properties/{propertyId}/rooms`
    - `GET /api/v1/landlord/properties/{propertyId}/rooms`
    - `GET /api/v1/landlord/rooms/{roomId}`
    - `PUT /api/v1/landlord/rooms/{roomId}`
    - `PATCH /api/v1/landlord/rooms/{roomId}/operational-status`
    - `PATCH /api/v1/landlord/rooms/{roomId}/visibility`
  - Định nghĩa các Response code: `200, 201, 400, 401, 403, 404, 409, 422, 500`.
- [x] **Step 2: Cập nhật `docs/openapi/room-discovery.yaml`**
  - Bổ sung URL canonical `/api/v1/rooms/{roomId}` tương đương `/api/v1/public/rooms/{roomId}`.
  - Đánh dấu `deprecated: true` cho `/api/v1/public/rooms/{roomId}`.
- [x] **Step 3: Verification**
  - Kiểm tra cú pháp YAML không có lỗi thụt dòng. Cả 68/68 `$ref` hợp lệ 100%.

---

### Task 2: Soạn thảo Đề xuất Migration Schema & Chốt Phê duyệt với Người dùng

**Files:**
- Modify: `prisma/schema.prisma` (Đã được User phê duyệt)
- Create: `docs/issues/15-migration-proposal.sql`

**Interfaces:**
- Produces: Ràng buộc duy nhất `@@unique([propertyId, roomCode])` trong database.

- [x] **Step 1: Tạo script SQL kiểm tra trùng lặp mã phòng**
  - Đã tạo `docs/issues/15-migration-proposal.sql`.
- [x] **Step 2: Soạn thảo diff schema**
  - Khai báo `@@unique([propertyId, roomCode], map: "uq_rooms_property_room_code")` trong model `Room`.
- [x] **Step 3: Trình người dùng phê duyệt**
  - Người dùng đã phê duyệt 100%.
- [x] **Step 4: Cập nhật schema và regenerate Prisma Client**
  - Đã cập nhật `prisma/schema.prisma` và chạy `npx prisma generate` thành công.

---

### Task 3: Định nghĩa Data Types, DTOs & Zod Validation Schemas

**Files:**
- Create: `src/modules/rooms/room-management.types.ts`
- Create: `src/modules/rooms/room-management.validation.ts`
- Test: `tests/rooms/room-management-validation.test.ts`

**Interfaces:**
- Produces: 
  - `CreateRoomInput`, `UpdateRoomInput`, `UpdateVisibilityInput`, `UpdateOperationalStatusInput`, `LandlordRoomListQuery`.
  - `createRoomSchema`, `updateRoomSchema`, `updateVisibilitySchema`, `updateOperationalStatusSchema`, `landlordRoomListQuerySchema`.

- [x] **Step 1: Viết failing test cho Zod Validation trong `tests/rooms/room-management-validation.test.ts`**
  - Kiểm tra: từ chối giá thuê âm, diện tích <= 0, `occupancyStatus` chuyển sang `HELD`/`RENTED`, mã phòng rỗng.
- [x] **Step 2: Chạy test để xác nhận FAIL**
- [x] **Step 3: Định nghĩa Types trong `src/modules/rooms/room-management.types.ts`**
  - Export các type và interface tương ứng DTO spec.
- [x] **Step 4: Hiện thực Zod Schemas trong `src/modules/rooms/room-management.validation.ts`**
  - Viết schema kiểm tra các trường bắt buộc và giới hạn số liệu không âm.
- [x] **Step 5: Chạy test để xác nhận PASS**
  - 24/24 tests PASS 100%, typecheck 0 lỗi.

---

### Task 4: Triển khai Room Management Repository

**Files:**
- Create: `src/modules/rooms/room-management.repository.ts`
- Test: `tests/rooms/room-management-repo.test.ts`

**Interfaces:**
- Produces:
  - `checkPropertyOwnership(propertyId: string, landlordId: string): Promise<boolean>`
  - `checkRoomOwnership(roomId: string, landlordId: string): Promise<Property & Room | null>`
  - `checkDuplicateRoomCode(propertyId: string, roomCode: string, excludeRoomId?: string): Promise<boolean>`
  - `checkActiveContractsOrRequests(roomId: string): Promise<boolean>` (Kiểm tra Contract ACTIVE/PENDING hoặc RentalRequest PENDING/ACCEPTED)
  - `createRoomTransaction(data: CreateRoomData): Promise<Room>`
  - `findLandlordRooms(propertyId: string, query: LandlordRoomListQuery): Promise<{ totalItems: number; items: Room[]; summary: RoomStatusSummary }>`
  - `findLandlordRoomById(roomId: string): Promise<RoomWithRelations | null>`
  - `updateRoomTransaction(roomId: string, data: UpdateRoomData): Promise<Room>` (Full replace RoomAmenity & RoomServiceFee)
  - `updateOperationalStatus(roomId: string, status: string, newVisibility?: string): Promise<Room>`
  - `updateVisibility(roomId: string, visibility: string): Promise<Room>`

- [x] **Step 1: Viết test cho Repository methods (mock prisma client)**
- [x] **Step 2: Triển khai Repository với Prisma Client**
  - Đảm bảo các hàm tạo và sửa phòng chạy trong `prisma.$transaction`.
  - Hàm `updateRoomTransaction` thực hiện xóa cũ và tạo mới `RoomAmenity` & `RoomServiceFee`.
  - Hàm `findLandlordRooms` tính toán song song summary counters và danh sách phân trang.
- [x] **Step 3: Chạy test repo để xác nhận PASS**
  - 20/20 unit tests PASS 100%, typecheck 0 lỗi.

---

### Task 5: Triển khai Room Management Service & State Machine Logic

**Files:**
- Create: `src/modules/rooms/room-management.service.ts`
- Modify: `src/modules/rooms/room.service.ts` (Thêm canonical method `getCanonicalRoomDetail`)
- Test: `tests/rooms/room-management-service.test.ts`

**Interfaces:**
- Produces:
  - `RoomManagementService.createRoom(...)`
  - `RoomManagementService.getLandlordRooms(...)`
  - `RoomManagementService.getLandlordRoomDetail(...)`
  - `RoomManagementService.updateRoom(...)`
  - `RoomManagementService.updateOperationalStatus(...)`
  - `RoomManagementService.updateVisibility(...)`

- [x] **Step 1: Viết failing test cho Business Rules & State Machine**
  - Test: Cấm chuyển `HELD/RENTED` (ném `ApiError(409)`).
  - Test: Khi chuyển sang `MAINTENANCE` $\rightarrow$ `visibilityStatus` chuyển về `HIDDEN`.
  - Test: Bật `VISIBLE` khi phòng `MAINTENANCE` hoặc `Property` INACTIVE $\rightarrow$ ném `ApiError(409)`.
  - Test: Service KHÔNG chứa import prisma singleton.
- [x] **Step 2: Triển khai `RoomManagementService`**
  - Tích hợp kiểm tra quyền sở hữu khu trọ và phòng trọ.
  - Tích hợp chuyển đổi trạng thái nghiêm ngặt.
- [x] **Step 3: Chạy test xác nhận PASS**
  - 24/24 unit tests PASS 100%, typecheck 0 lỗi.

---

### Task 6: Triển khai Controller, Routes & Route Order Normalization

**Files:**
- Create: `src/modules/rooms/room-management.controller.ts`
- Modify: `src/modules/rooms/room.controller.ts`
- Modify: `src/modules/rooms/room.routes.ts`

**Interfaces:**
- Produces: Đầy đủ 8 endpoints cho Chủ trọ + 2 endpoints Public.

- [x] **Step 1: Triển khai `room-management.controller.ts`**
  - Trích xuất `res.locals.userId` từ `requireRole('LANDLORD')`.
  - Validate body/params/query bằng Zod schema.
  - Gọi Service tương ứng và trả HTTP status (201 cho POST, 200 cho GET/PATCH/PUT).
- [x] **Step 2: Cập nhật `src/modules/rooms/room.routes.ts`**
  - Tạo routes chủ trọ với middleware `requireRole('LANDLORD')`.
  - Đăng ký các endpoints của chủ trọ.
  - **Sắp xếp route:** Đảm bảo `GET /api/v1/rooms/search` được khai báo TRƯỚC `GET /api/v1/rooms/:roomId`.
  - Đăng ký alias `GET /api/v1/public/rooms/:roomId` trỏ cùng Controller handler với `/rooms/:roomId` và đính kèm response header `Deprecation: @true`.
- [x] **Step 3: Chạy typecheck**
  - Run: `npm run typecheck`
  - Đạt 0 lỗi TypeScript.

---

### Task 7: Bộ Kiểm thử Tích hợp Toàn diện & Nghiệm thu (Verification Gate)

**Files:**
- Create: `tests/rooms/room-management-api.test.ts`

- [x] **Step 1: Viết API Integration tests với Node.js test runner**
  - Kiểm thử đầy đủ luồng: Tạo phòng $\rightarrow$ Lấy danh sách $\rightarrow$ Chuyển trạng thái $\rightarrow$ Đổi hiển thị $\rightarrow$ Xem công khai.
  - Kiểm thử bảo mật: Người dùng khác không thể truy cập phòng không phải của mình.
  - 18/18 API integration test cases PASS.
- [x] **Step 2: Chạy toàn bộ Verification Checklist theo `AGENTS.md`**
  1. `npm run typecheck` (0 lỗi TypeScript)
  2. `npm run build` (Biên dịch thành công sang `dist/`)
  3. `npx tsx --test tests/rooms/*.test.ts` (Toàn bộ 86/86 test cases PASS 100%)
  4. `git status` (Kiểm tra working tree sạch sẽ, đúng phạm vi cho phép)
