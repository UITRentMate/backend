# Technical Design Specification: Quản lý Thành viên Cư trú & Lời mời ở cùng (BE-P3-08)

- **Mã Issue:** `UITRentMate/backend#37` (`[BE-P3-08] Quản lý Thành viên Cư trú & Lời mời ở cùng (BR-10, BR-11)`)
- **Tác giả:** Feature Architect (đối chiếu yêu cầu đã chốt giữa Owner & Team Lead)
- **Ngày lập:** 2026-11-22
- **Nhánh dự kiến khi triển khai:** `feat/be-p3-08-contract-residents` (tách trực tiếp từ `origin/staging`)
- **Module mục tiêu:** `src/modules/residents/`
- **Đặc tả OpenAPI 3.1:** [docs/openapi/contract-residents.yaml](../../openapi/contract-residents.yaml)
- **Kế hoạch triển khai:** [docs/superpowers/plans/2026-11-22-contract-residents.md](../plans/2026-11-22-contract-residents.md)
- **Trạng thái:** `Approved (Refine Final — 2026-11-22)`

---

## 1. Mục tiêu Nghiệp vụ & Phạm vi

Xây dựng phân hệ Quản lý Thành viên Cư trú & Lời mời ở cùng (`UC-15`, `BR-10`, `BR-11`) cho hợp đồng thuê phòng đang hiệu lực (`ACTIVE`):

1. **Quản lý danh sách cư trú (`BR-10`):** Hiển thị rõ Chủ hợp đồng (`PRIMARY_TENANT`) và danh sách Người ở cùng đang cư trú (`CO_RESIDENT` với `leftAt IS NULL`), tính chính xác sức chứa `currentOccupants = 1 + activeCoResidents` so với `Room.maxOccupants`, đồng thời trả kèm danh sách lời mời `PENDING` còn hạn cho Chủ hợp đồng / Chủ trọ (ẩn với Người ở cùng).
2. **Quy trình lời mời ở cùng có thời hạn 72 giờ:** Chủ hợp đồng hoặc Chủ trọ sở hữu phòng gửi lời mời cho tài khoản RentMate `TENANT ACTIVE` thông qua `email` hoặc số điện thoại (`identifier`, tuyệt đối không nhận `userId` UUID). Người được mời xem hộp thư lời mời, chấp nhận hoặc từ chối; người gửi / Chủ hợp đồng / Chủ trọ có thể thu hồi lời mời đang `PENDING`.
3. **Bảo đảm sức chứa tuyệt đối dưới tải đồng thời (`BR-11`):** Khi nhiều người được mời đồng thời bấm `/accept` vào cùng một hợp đồng, hệ thống khóa hàng `contracts` (`SELECT ... FOR UPDATE`) để tổng số người ở không bao giờ vượt quá `Room.maxOccupants`.
4. **Hỗ trợ người cũ quay lại ở cùng:** Dùng `upsert` trên khóa chính tổng hợp `ContractResident(contractId, userId)` để người từng rời phòng (`leftAt != null`) có thể được mời lại và quay lại hợp đồng mà không lỗi trùng khóa chính.
5. **Gỡ người ở cùng & Tự rời phòng (`BR-10`):** Soft-remove (`leftAt = now()`); cấm tuyệt đối gỡ Chủ hợp đồng (`400 CANNOT_REMOVE_PRIMARY_TENANT`); Chủ hợp đồng / Chủ trọ gỡ được bất kỳ `CO_RESIDENT` nào; `CO_RESIDENT` chỉ được tự rời phòng (`userId === currentUser.id`).
6. **Thông báo & Nhật ký kiểm toán bắt buộc (`BR-23`):** Ghi nhận nguyên tử trong cùng database transaction cả `Notification` (5 sự kiện, tương thích payload chuẩn PR #40) lẫn `AuditLog` (5 thao tác thay đổi trạng thái).

### Ngoài phạm vi (Out of Scope)
- Mời người chưa có tài khoản RentMate (sẽ không tạo tài khoản tạm hoặc gửi email mời đăng ký).
- Xuất báo cáo tạm trú / khai báo nhân khẩu (Phase 5).
- Thay đổi `prisma/schema.prisma` hoặc tạo migration mới.

---

## 2. Ranh giới Kiến trúc & Đối chiếu Schema hiện tại

### 2.1. Zero DB Schema Drift — Các ràng buộc thực tế từ `prisma/schema.prisma`
Kiểm tra trực tiếp `prisma/schema.prisma` trên `origin/staging` (`20261121060000_phase3_shared_schema`):

| Bảng / Model | Ràng buộc quan trọng cần tuân thủ | Hệ quả thiết kế |
|---|---|---|
| `ContractResident` (`contract_residents`) | `@@id([contractId, userId])`, cột `joinedAt`, `leftAt` | **Chỉ lưu `CO_RESIDENT`** (`userId !== contract.tenantId`). Khi người cũ quay lại bắt buộc `upsert` theo `contractId_userId` đặt `leftAt = null, joinedAt = now()`. |
| `ResidentInvitation` (`resident_invitations`) | `id (Uuid)`, `contractId`, `invitedUserId`, `invitedById`, `status (VarChar(20))`, `expiresAt`, `acceptedAt`, `@@index([invitedUserId, status])` | **KHÔNG có cột `createdAt` và KHÔNG có partial unique index cho `(contractId, invitedUserId) WHERE status = 'PENDING'`.** Do đó: (1) sắp xếp danh sách bằng `[{ expiresAt: 'desc' }, { id: 'desc' }]` (tương đương mới nhất trước vì TTL cố định 72h); (2) chống trùng `PENDING` song song bằng khóa hàng `contracts FOR UPDATE` trong `POST /invitations`. |
| `Notification` (`notifications`) | `title VarChar(200)`, `eventType VarChar(40)`, `payload JsonB`, `@@index([recipientId, isRead, createdAt(sort: Desc)])` | Mọi `eventType` mới phải `<= 40` ký tự (`RESIDENT_INVITATION_REJECTED` = 28, `RESIDENT_INVITATION_CANCELLED` = 29); `title` luôn giữ ngắn gọn `< 160` ký tự. |
| `AuditLog` (`audit_logs`) | `actorId Uuid?`, `entityType VarChar(60)`, `entityId Uuid`, `action VarChar(60)`, `oldData JsonB?`, `newData JsonB?` | `entityId` bắt buộc là **UUID hợp lệ**. Với `ResidentInvitation` dùng `invitation.id`; với `ContractResident` (khóa chính tổng hợp, không có UUID đơn) dùng `contractId` làm `entityId` và lưu `userId` trong `oldData`/`newData`. |
| `User` (`users`) | `email @unique VarChar(255)`, `phone @unique VarChar(20)`, `role VarChar(20)`, `accountStatus VarChar(25)`, `avatarUrl Text?` | Tuyệt đối không select hoặc trả về `passwordHash` / `password_hash`. |

### 2.2. Kiến trúc Phân tầng (Layered Modular Monolith)
Tuân thủ nghiêm ngặt luồng trong `AGENTS.md` & `docs/folder_structure.md`:

```text
Request ──► resident.routes.ts (requireRole)
              ──► resident.controller.ts (parse & validate via Zod)
                    ──► resident.service.ts (business rules, authz/Anti-IDOR, mapper)
                          ──► resident.repository.ts (Prisma Client Singleton, $transaction, FOR UPDATE)
                                ──► PostgreSQL
```

- `resident.service.ts` **tuyệt đối không import** `src/infrastructure/database/prisma.ts` (có unit test tĩnh kiểm tra).
- Toàn bộ giao dịch nguyên tử (`$transaction`, `createNotification`/`createNotificationsBatch`, `recordAuditLog`) được đóng gói trong `resident.repository.ts` và điều phối bởi `resident.service.ts`.
- `src/app.ts` chỉ thêm đúng 1 dòng import và 1 dòng `app.use(residentRouter);`.

### 2.3. Tương thích & Chống xung đột với PR #40 (`feat/be-p3-07-notifications-api`)
PR #40 hiện đang mở trên nhánh `feat/be-p3-07-notifications-api` và sửa `src/common/constants/phase3-status.ts`, `src/common/utils/notification.util.ts`, `src/app.ts`:

1. **`src/common/constants/phase3-status.ts`:**
   - Nhánh `feat/be-p3-08-contract-residents` chỉ thêm **đúng 2 dòng** vào `NOTIFICATION_EVENT_TYPE`:
     - `RESIDENT_INVITATION_REJECTED: 'RESIDENT_INVITATION_REJECTED',`
     - `RESIDENT_INVITATION_CANCELLED: 'RESIDENT_INVITATION_CANCELLED',`
   - **CẢNH BÁO MERGE QUAN TRỌNG VỚI PR #40:** Trong PR #40, `phase3-status.ts` định nghĩa bản đồ kiểu chặt `NOTIFICATION_CATEGORY_BY_EVENT: Readonly<Record<NotificationEventType, NotificationCategory>>`. Khi merge nhánh này với `staging` (sau khi PR #40 đã merge), TypeScript sẽ yêu cầu bổ sung 2 khóa mới vào `NOTIFICATION_CATEGORY_BY_EVENT` với giá trị `NOTIFICATION_CATEGORY.BOOKING_CONTRACT`. Kế hoạch triển khai ghi chú rõ bước kiểm tra này cho Builder.
2. **`src/common/utils/notification.util.ts`:**
   - **KHÔNG chỉnh sửa** file này trên nhánh `feat/be-p3-08-contract-residents` để tránh merge conflict với PR #40.
   - Truyền `payload` dưới dạng plain JSON object có cấu trúc đúng chuẩn `NotificationPayload` của PR #40:
     ```ts
     {
       content: string,
       actionUrl: string,
       relatedEntityType: 'RESIDENT_INVITATION' | 'CONTRACT',
       relatedEntityId: string,
       metadata: Record<string, string | number | boolean | null>,
     }
     ```
     Cấu trúc này hợp lệ 100% với kiểu `Prisma.InputJsonValue` trên `origin/staging` hiện tại VÀ tương thích 100% với kiểu `NotificationPayload` + `notification.mapper.ts` sau khi PR #40 merge.
3. **`src/app.ts`:**
   - Thêm đúng 1 dòng import `residentRouter` (theo thứ tự alphabet giữa `rentalRequestRouter` và `roomRouter`) và 1 dòng `app.use(residentRouter);` cuối nhóm module router.

---

## 3. Thiết kế Concurrency, Khóa Giao dịch & Tránh Bẫy Rollback

### 3.1. Lựa chọn chiến lược kiểm soát đồng thời (Concurrency Control)
So sánh 2 hướng tiếp cận:
- **Hướng A (Được chọn — Khuyến nghị):** Pessimistic Row-Level Lock trên bản ghi cha `contracts`:
  ```sql
  SELECT id FROM contracts WHERE id = $1::uuid FOR UPDATE
  ```
  (thực thi bằng tagged template parameterized `tx.$queryRaw\`SELECT id FROM contracts WHERE id = ${contractId}::uuid FOR UPDATE\``).
  - **Ưu điểm:** Tuần tự hóa hoàn toàn mọi thao tác thay đổi cư dân/lời mời trên cùng một hợp đồng (`POST /invitations`, `PATCH /accept`, `PATCH /reject`, `PATCH /cancel`, `DELETE /residents/:userId`); không cần thêm DB index mới (Zero Schema Drift); một thứ tự khóa duy nhất theo `contractId` nên **triệt tiêu hoàn toàn nguy cơ deadlock**; không cần vòng lặp retry `P2034` như `Serializable`.
  - **Đánh đổi:** Giảm song song nhẹ nếu hàng trăm thao tác cư trú xảy ra cùng lúc trên *cùng 1 hợp đồng* (không ảnh hưởng các hợp đồng khác nhau — hoàn toàn phù hợp quy mô phòng trọ).
- **Hướng B (Loại bỏ):** Isolation level `Serializable` + retry loop. Phức tạp hơn, dễ phát sinh false serialization failure trên các trang index dùng chung giữa các hợp đồng khác nhau, và không khớp chỉ đạo khóa hàng `Contract` (`SELECT ... FOR UPDATE`) đã chốt trong Issue #37.

### 3.2. Xử lý bẫy Rollback khi Lazy-Expire trong `$transaction` (Cực kỳ quan trọng)
Trong PostgreSQL + Prisma Interactive `$transaction`, nếu cập nhật `status = 'EXPIRED'` rồi `throw new ApiError(409, 'INVITATION_EXPIRED', ...)` ngay trong callback `$transaction`, **PostgreSQL sẽ ROLLBACK lệnh `UPDATE`**, khiến bản ghi vẫn giữ trạng thái `PENDING` trong DB.

**Quy chuẩn bắt buộc cho `PATCH /accept`, `PATCH /reject`, `PATCH /cancel`:**
- Trong `$transaction`, nếu phát hiện `invitation.status === 'PENDING' && invitation.expiresAt <= now`:
  1. Cập nhật `tx.residentInvitation.update({ where: { id: invitationId }, data: { status: RESIDENT_INVITATION_STATUS.EXPIRED } })`.
  2. Trả về discriminated union `{ outcome: 'EXPIRED' }` để `$transaction` **COMMIT** trạng thái `EXPIRED` xuống DB.
  3. Tại tầng `resident.service.ts`, kiểm tra `if (result.outcome === 'EXPIRED')` rồi mới `throw new ApiError(409, 'INVITATION_EXPIRED', 'Lời mời ở cùng đã hết hạn sau 72 giờ')`.
- Mọi lỗi khác không cần lưu thay đổi (`CONTRACT_NOT_ACTIVE`, `ROOM_CAPACITY_EXCEEDED`, `INVITATION_NOT_PENDING`, `ALREADY_RESIDENT`, `RESIDENT_NOT_FOUND`) được ném `ApiError` trực tiếp trong `$transaction` để rollback toàn bộ thay đổi dở dang (không bao giờ để lại `Notification` hoặc `AuditLog` mồ côi).

### 3.3. Xử lý người cũ quay lại ở cùng (`ContractResident` Composite PK)
Trong `PATCH /accept` (bên trong khóa `Contract FOR UPDATE`):
1. Đọc bản ghi cũ (nếu có) bằng `tx.contractResident.findUnique({ where: { contractId_userId: { contractId, userId } } })`.
2. Nếu tồn tại và `leftAt === null` → ném `409 ALREADY_RESIDENT`.
3. Thực hiện `tx.contractResident.upsert`:
   - `where: { contractId_userId: { contractId, userId } }`
   - `create: { contractId, userId, joinedAt: now, leftAt: null }`
   - `update: { joinedAt: now, leftAt: null }`
4. `AuditLog.oldData` lưu trạng thái trước đó (`null` nếu vào lần đầu; `{ rejoinedFromLeftAt: existing.leftAt.toISOString(), previousJoinedAt: existing.joinedAt.toISOString() }` nếu quay lại).

---

## 4. State Machine & Quy tắc Nghiệp vụ (`BR-10`, `BR-11`)

### 4.1. Vòng đời `ResidentInvitation`
```text
             ┌──► ACCEPTED  (invitedUserId chấp nhận, trong hạn, contract ACTIVE, còn chỗ)
             ├──► REJECTED  (invitedUserId từ chối, trong hạn)
PENDING ─────┼──► CANCELLED (invitedById / Primary Tenant / Landlord thu hồi, trong hạn)
             └──► EXPIRED   (tự động chuyển khi expiresAt <= now lúc đọc/mời lại/xử lý)
```
- `ACCEPTED`, `REJECTED`, `CANCELLED`, `EXPIRED` là **trạng thái cuối (immutable)**.
- Thời hạn lời mời: `expiresAt = now + PHASE3_TIME_LIMITS_MS.RESIDENT_INVITATION_TTL_MS` (72 giờ).
- Quy tắc giao thoa nhiều hợp đồng: Một `TENANT` được phép ở đồng thời nhiều hợp đồng khác nhau; kiểm tra trùng `ALREADY_RESIDENT` / `INVITATION_ALREADY_PENDING` chỉ giới hạn trong **cùng 1 `contractId`**.

### 4.2. Công thức Sức chứa (`BR-11`)
```text
activeCoResidents = COUNT(contract_residents WHERE contract_id = :contractId AND left_at IS NULL)
currentOccupants  = 1 (Primary Tenant) + activeCoResidents
remainingSlots    = MAX(0, room.maxOccupants - currentOccupants)
Điều kiện hợp lệ  : currentOccupants <= room.maxOccupants
Điều kiện mời/vào : currentOccupants < room.maxOccupants
```
- Mọi thao tác mời (`POST /invitations`), chấp nhận (`PATCH /accept`), gỡ/tự rời (`DELETE /residents/:userId`) bắt buộc `contract.status === 'ACTIVE'` (nếu không → `409 CONTRACT_NOT_ACTIVE`).
- Thao tác xem danh sách (`GET /contracts/:contractId/residents`): Cho phép đọc với mọi trạng thái hợp đồng mà caller có quyền (Primary Tenant / Landlord / Active Co-Resident) và trả rõ trường `contractStatus` (hữu ích khi hợp đồng đang `LIQUIDATING` hoặc đã `TERMINATED`).
- Thao tác thu hồi lời mời (`PATCH /cancel`) và từ chối (`PATCH /reject`): Cho phép xử lý lời mời đang `PENDING` còn hạn ngay cả khi hợp đồng không còn `ACTIVE`, để dọn sạch lời mời tồn đọng.

---

## 5. Ma trận Phân quyền, Anti-IDOR & Bảo mật

| Endpoint | Middleware | Primary Tenant | Landlord sở hữu phòng | Active Co-Resident | Former Co-Resident (`leftAt != null`) | Invited User | Người ngoài (Tenant/Landlord khác) | Admin | Account bị khóa |
|---|---|---|---|---|---|---|---|---|---|
| `GET /contracts/:contractId/residents` | `requireRole('TENANT', 'LANDLORD')` | `200` (kèm `pendingInvitations`) | `200` (kèm `pendingInvitations`) | `200` (`pendingInvitations: null`) | `404 CONTRACT_NOT_FOUND` | `404 CONTRACT_NOT_FOUND` | `404 CONTRACT_NOT_FOUND` | `403 FORBIDDEN` | `403 ACCOUNT_LOCKED` |
| `POST /contracts/:contractId/invitations` | `requireRole('TENANT', 'LANDLORD')` | `201` | `201` | `403 FORBIDDEN` | `404 CONTRACT_NOT_FOUND` | `404 CONTRACT_NOT_FOUND` | `404 CONTRACT_NOT_FOUND` | `403 FORBIDDEN` | `403 ACCOUNT_LOCKED` |
| `GET /resident-invitations` | `requireRole('TENANT')` | `200` (hộp thư cá nhân) | `403 FORBIDDEN` | `200` (hộp thư cá nhân) | `200` (hộp thư cá nhân) | `200` (hộp thư cá nhân) | `200` (chỉ thấy của mình) | `403 FORBIDDEN` | `403 ACCOUNT_LOCKED` |
| `PATCH /resident-invitations/:invitationId/accept` | `requireRole('TENANT')` | `404 INVITATION_NOT_FOUND` | `403 FORBIDDEN` | `404 INVITATION_NOT_FOUND` | `404 INVITATION_NOT_FOUND` | `200` | `404 INVITATION_NOT_FOUND` | `403 FORBIDDEN` | `403 ACCOUNT_LOCKED` |
| `PATCH /resident-invitations/:invitationId/reject` | `requireRole('TENANT')` | `404 INVITATION_NOT_FOUND` | `403 FORBIDDEN` | `404 INVITATION_NOT_FOUND` | `404 INVITATION_NOT_FOUND` | `200` | `404 INVITATION_NOT_FOUND` | `403 FORBIDDEN` | `403 ACCOUNT_LOCKED` |
| `PATCH /resident-invitations/:invitationId/cancel` | `requireRole('TENANT', 'LANDLORD')` | `200` | `200` | `404 INVITATION_NOT_FOUND` | `404 INVITATION_NOT_FOUND` | `404 INVITATION_NOT_FOUND` | `404 INVITATION_NOT_FOUND` | `403 FORBIDDEN` | `403 ACCOUNT_LOCKED` |
| `DELETE /contracts/:contractId/residents/:userId` | `requireRole('TENANT', 'LANDLORD')` | `200` (gỡ Co-Res) / `400` (tự xóa mình) | `200` (gỡ Co-Res) / `400` (xóa Primary) | `200` (tự rời mình) / `403` (gỡ người khác) | `404 CONTRACT_NOT_FOUND` | `404 CONTRACT_NOT_FOUND` | `404 CONTRACT_NOT_FOUND` | `403 FORBIDDEN` | `403 ACCOUNT_LOCKED` |

### Nguyên tắc Bảo mật Dữ liệu & Đầu vào (`security-review`)
1. **Không lộ thông tin nhạy cảm (PII / Credentials):** Mọi truy vấn `User` dùng explicit `select: { id: true, fullName: true, avatarUrl: true }` — tuyệt đối không trả về `passwordHash`, `password_hash`, `email`, `phone` trong danh sách cư trú/lời mời (Privacy-by-Default đã chốt tại Cổng duyệt #1: ẩn hoàn toàn `email` / `phone` để tránh rò rỉ dữ liệu liên lạc chéo giữa các bên).
2. **Chống dò UUID khi mời (`POST /invitations`):** Body chỉ chấp nhận `{ identifier: string }` (`.strict()` schema, từ chối mọi trường thừa như `userId`). `identifier` sau khi `trim()` phải khớp Email hợp lệ (normalize lowercase, `<= 255` ký tự) HOẶC SĐT Việt Nam `/^0\d{9}$/` (khớp chuẩn `src/modules/auth/auth.validation.ts`). Chuỗi UUID sẽ bị chặn ngay ở tầng validation với `400 VALIDATION_ERROR`.
3. **Thứ tự kiểm tra trên `DELETE /contracts/:contractId/residents/:userId`:**
   - Bước 1: Kiểm tra tồn tại hợp đồng & caller thuộc `{PRIMARY_TENANT, LANDLORD, ACTIVE_CO_RESIDENT}` → nếu không thuộc: `404 CONTRACT_NOT_FOUND` (Anti-IDOR).
   - Bước 2: Nếu caller là `ACTIVE_CO_RESIDENT` (không phải Primary/Landlord) và `userId !== currentUser.id` → `403 FORBIDDEN`.
   - Bước 3: Nếu `userId === contract.tenantId` → `400 CANNOT_REMOVE_PRIMARY_TENANT` (`BR-10`).
   - Bước 4 (dưới khóa `Contract FOR UPDATE`): Kiểm tra `contract.status === 'ACTIVE'` (`409 CONTRACT_NOT_ACTIVE`) → kiểm tra tồn tại `ContractResident` có `leftAt IS NULL` (`404 RESIDENT_NOT_FOUND`) → cập nhật `leftAt = now()`.

---

## 6. Đặc tả Chi tiết 7 Endpoints & Mã Lỗi Chuẩn

### 6.1. Bảng tóm tắt Endpoints
| # | Method | Path | Auth | Success |
|---|---|---|---|---|
| 1 | `GET` | `/api/v1/contracts/:contractId/residents` | `requireRole('TENANT', 'LANDLORD')` | `200 OK` |
| 2 | `POST` | `/api/v1/contracts/:contractId/invitations` | `requireRole('TENANT', 'LANDLORD')` | `201 Created` |
| 3 | `GET` | `/api/v1/resident-invitations` | `requireRole('TENANT')` | `200 OK` |
| 4 | `PATCH` | `/api/v1/resident-invitations/:invitationId/accept` | `requireRole('TENANT')` | `200 OK` |
| 5 | `PATCH` | `/api/v1/resident-invitations/:invitationId/reject` | `requireRole('TENANT')` | `200 OK` |
| 6 | `PATCH` | `/api/v1/resident-invitations/:invitationId/cancel` | `requireRole('TENANT', 'LANDLORD')` | `200 OK` |
| 7 | `DELETE` | `/api/v1/contracts/:contractId/residents/:userId` | `requireRole('TENANT', 'LANDLORD')` | `200 OK` |

### 6.2. Quy ước DTO chính (chi tiết đầy đủ tại `docs/openapi/contract-residents.yaml`)
- **`GET /api/v1/contracts/:contractId/residents` → `200 OK`:**
  `{ contractId, contractStatus, room: { id, roomCode, maxOccupants, property: { id, name } }, currentOccupants, maxOccupants, remainingSlots, residents: ResidentItemDTO[], pendingInvitations: ContractPendingInvitationDTO[] | null }`
  - `residents[0]` luôn là `PRIMARY_TENANT` (`joinedAt = contract.activatedAt?.toISOString() ?? null`); các phần tử tiếp theo là `CO_RESIDENT` (`leftAt IS NULL`, sắp xếp `joinedAt ASC, userId ASC`).
  - `pendingInvitations`: mảng lời mời `PENDING` còn hạn (sắp xếp `expiresAt DESC, id DESC`) khi caller là `PRIMARY_TENANT` hoặc `LANDLORD`; `null` khi caller là `CO_RESIDENT`.
- **`POST /api/v1/contracts/:contractId/invitations` → `201 Created`:**
  Request: `{ identifier: string }`
  Response: `{ invitationId, contractId, status: 'PENDING', expiresAt, invitedUser: UserSummaryDTO, invitedBy: UserSummaryDTO }`
- **`GET /api/v1/resident-invitations` → `200 OK`:**
  Query: `status?` (`PENDING | ACCEPTED | REJECTED | CANCELLED | EXPIRED`), `page` (default `1`, `>= 1`), `limit` (default `20`, `1..50`; hỗ trợ alias `pageSize`, ưu tiên `limit` — khớp chuẩn PR #40).
  Response: `{ items: ReceivedInvitationItemDTO[], total, page, limit, totalPages }` (tự lazy-expire `PENDING` có `expiresAt <= now` trước khi lọc & đếm).
- **`PATCH /api/v1/resident-invitations/:invitationId/accept` → `200 OK`:**
  Response: `{ invitationId, contractId, status: 'ACCEPTED', acceptedAt, resident: ResidentItemDTO, currentOccupants, maxOccupants }`
- **`PATCH /api/v1/resident-invitations/:invitationId/reject` → `200 OK`:**
  Response: `{ invitationId, contractId, status: 'REJECTED' }`
- **`PATCH /api/v1/resident-invitations/:invitationId/cancel` → `200 OK`:**
  Response: `{ invitationId, contractId, status: 'CANCELLED' }`
- **`DELETE /api/v1/contracts/:contractId/residents/:userId` → `200 OK`:**
  Response: `{ contractId, userId, leftAt, removalType: 'SELF_LEAVE' | 'REMOVED_BY_PRIMARY_TENANT' | 'REMOVED_BY_LANDLORD', currentOccupants, maxOccupants }`

### 6.3. Bảng Mã Lỗi `ApiError` Chuẩn
| HTTP | `code` | Ngữ cảnh phát sinh |
|---|---|---|
| `400` | `VALIDATION_ERROR` | UUID path param sai định dạng, `identifier` không phải email/SĐT hợp lệ, trường thừa (`.strict()`), query `status`/`page`/`limit` sai |
| `400` | `INVITEE_NOT_ELIGIBLE` | Tài khoản đích không có `role === 'TENANT'` hoặc `accountStatus !== 'ACTIVE'` |
| `400` | `CANNOT_REMOVE_PRIMARY_TENANT` | Cố gắng xóa Chủ hợp đồng (`userId === contract.tenantId`) theo `BR-10` |
| `401` | `UNAUTHORIZED` | Thiếu hoặc JWT Access Token không hợp lệ |
| `403` | `ACCOUNT_LOCKED` | Tài khoản gọi API không ở trạng thái `ACTIVE` |
| `403` | `FORBIDDEN` | Vai trò không hợp lệ; `CO_RESIDENT` cố gửi lời mời; `CO_RESIDENT` cố gỡ người ở cùng khác |
| `404` | `CONTRACT_NOT_FOUND` | Hợp đồng không tồn tại hoặc caller không liên quan (Anti-IDOR) |
| `404` | `INVITEE_NOT_FOUND` | Không tìm thấy tài khoản RentMate theo `email`/`phone` |
| `404` | `INVITATION_NOT_FOUND` | Lời mời không tồn tại hoặc caller không có quyền truy cập (Anti-IDOR) |
| `404` | `RESIDENT_NOT_FOUND` | `userId` không phải `CO_RESIDENT` đang ở (`leftAt IS NULL`) của hợp đồng |
| `409` | `CONTRACT_NOT_ACTIVE` | Hợp đồng không ở trạng thái `ACTIVE` khi mời / chấp nhận / gỡ |
| `409` | `ALREADY_PRIMARY_TENANT` | Mời chính Chủ hợp đồng của hợp đồng này |
| `409` | `ALREADY_RESIDENT` | Người được mời đã là `CO_RESIDENT` đang ở (`leftAt IS NULL`) của hợp đồng này |
| `409` | `INVITATION_ALREADY_PENDING` | Đã tồn tại lời mời `PENDING` còn hạn cho cùng `(contractId, invitedUserId)` |
| `409` | `ROOM_CAPACITY_EXCEEDED` | Phòng đã đạt sức chứa tối đa (`currentOccupants >= room.maxOccupants`, `BR-11`) |
| `409` | `INVITATION_EXPIRED` | Lời mời đã quá 72 giờ (`EXPIRED` hoặc `PENDING` có `expiresAt <= now`) |
| `409` | `INVITATION_NOT_PENDING` | Lời mời đã ở trạng thái cuối khác (`ACCEPTED`, `REJECTED`, `CANCELLED`) |

---

## 7. Ma trận Notification (5 sự kiện) & AuditLog (5 hành động)

Toàn bộ `createNotification` / `createNotificationsBatch` và `recordAuditLog` được gọi **bên trong cùng `prisma.$transaction`** để bảo đảm tính nguyên tử (rollback nếu thao tác thất bại).

### 7.1. Notification Matrix (tương thích 100% payload PR #40)
| # | Sự kiện | `eventType` (<= 40 chars) | Người nhận (deduplicated) | `title` mẫu | `actionUrl` | `relatedEntityType` / `relatedEntityId` |
|---|---|---|---|---|---|---|
| 1 | Mời ở cùng (`POST /invitations`) | `RESIDENT_INVITATION_RECEIVED` (có sẵn) | `invitedUserId` | `Lời mời ở cùng phòng ${roomCode}` | `/resident-invitations` | `RESIDENT_INVITATION` / `invitation.id` |
| 2 | Chấp nhận (`PATCH /accept`) | `RESIDENT_JOINED` (có sẵn) | Chủ HĐ (`contract.tenantId`) & Chủ trọ (`landlordId`) | `${residentName} đã tham gia phòng ${roomCode}` | Chủ HĐ: `/contracts/${contractId}/residents`<br>Chủ trọ: `/landlord/contracts/${contractId}/residents` | `CONTRACT` / `contractId` |
| 3 | Từ chối (`PATCH /reject`) | `RESIDENT_INVITATION_REJECTED` (**thêm mới**, 28 chars) | Người gửi lời mời (`invitation.invitedById`) | `${inviteeName} đã từ chối lời mời phòng ${roomCode}` | Chủ trọ: `/landlord/contracts/${contractId}/residents`<br>Chủ HĐ: `/contracts/${contractId}/residents` | `RESIDENT_INVITATION` / `invitation.id` |
| 4 | Thu hồi (`PATCH /cancel`) | `RESIDENT_INVITATION_CANCELLED` (**thêm mới**, 29 chars) | `invitedUserId` | `Lời mời ở cùng phòng ${roomCode} đã bị thu hồi` | `/resident-invitations` | `RESIDENT_INVITATION` / `invitation.id` |
| 5 | Gỡ / Tự rời (`DELETE /residents/:userId`) | `RESIDENT_REMOVED` (có sẵn) | **Cả 3 actor:** Chủ trọ (`landlordId`), Chủ HĐ (`contract.tenantId`) và Người ở cùng bị gỡ / tự rời (`userId`) | Tự rời: `${residentName} đã rời phòng ${roomCode}`<br>Bị gỡ: `${residentName} đã được gỡ khỏi phòng ${roomCode}` | Chủ trọ: `/landlord/contracts/${contractId}/residents`<br>Chủ HĐ: `/contracts/${contractId}/residents`<br>Người ở cùng vừa rời: `/contracts` *(tránh trỏ link 404 sau khi mất quyền)* | `CONTRACT` / `contractId` |

Mỗi `payload` đều có đầy đủ 5 trường chuẩn PR #40: `{ content, actionUrl, relatedEntityType, relatedEntityId, metadata }`.

### 7.2. AuditLog Matrix (`recordAuditLog(tx, ...)`)
| # | Thao tác | `actorId` | `entityType` | `entityId` (UUID) | `action` | `oldData` | `newData` |
|---|---|---|---|---|---|---|---|
| 1 | `POST /invitations` | `currentUser.id` | `RESIDENT_INVITATION` | `invitation.id` | `RESIDENT_INVITATION_CREATED` | `null` | `{ contractId, invitedUserId, invitedById, status: 'PENDING', expiresAt }` |
| 2 | `PATCH /accept` | `currentUser.id` | `RESIDENT_INVITATION` | `invitation.id` | `RESIDENT_INVITATION_ACCEPTED` | `{ status: 'PENDING', previousResident: null \| { joinedAt, leftAt } }` | `{ status: 'ACCEPTED', acceptedAt, contractId, userId, joinedAt, leftAt: null, currentOccupants }` |
| 3 | `PATCH /reject` | `currentUser.id` | `RESIDENT_INVITATION` | `invitation.id` | `RESIDENT_INVITATION_REJECTED` | `{ status: 'PENDING' }` | `{ status: 'REJECTED', contractId, invitedUserId }` |
| 4 | `PATCH /cancel` | `currentUser.id` | `RESIDENT_INVITATION` | `invitation.id` | `RESIDENT_INVITATION_CANCELLED` | `{ status: 'PENDING' }` | `{ status: 'CANCELLED', contractId, invitedUserId, cancelledById }` |
| 5 | `DELETE /residents/:userId` | `currentUser.id` | `CONTRACT_RESIDENT` | `contractId` | `RESIDENT_SELF_LEFT` hoặc `RESIDENT_REMOVED` | `{ contractId, userId, joinedAt, leftAt: null }` | `{ contractId, userId, joinedAt, leftAt, removalType, currentOccupants }` |

---

## 8. Cấu trúc File Module & Chiến lược Kiểm thử

### 8.1. Files tạo mới / cập nhật khi triển khai
- **Cập nhật (tối thiểu):**
  - `src/common/constants/phase3-status.ts`: Thêm 2 hằng số `RESIDENT_INVITATION_REJECTED`, `RESIDENT_INVITATION_CANCELLED` (và map `BOOKING_CONTRACT` nếu PR #40 đã merge).
  - `src/app.ts`: Thêm 1 dòng import + 1 dòng `app.use(residentRouter);`.
- **Tạo mới trong `src/modules/residents/`:**
  - `resident.types.ts` — DTOs, input/query interfaces, repository result types.
  - `resident.validation.ts` — Zod schemas (`validateContractId`, `validateUserId`, `validateInvitationId`, `validateCreateInvitationBody`, `validateInvitationListQuery`).
  - `resident.mapper.ts` — Chuyển đổi Prisma rows sang Response DTO (explicit allowlist, không rò rỉ PII).
  - `resident.repository.ts` — Toàn bộ truy vấn Prisma, `SELECT ... FOR UPDATE` trên `contracts`, `upsert` `ContractResident`, `createNotification`/`createNotificationsBatch`, `recordAuditLog`.
  - `resident.service.ts` — Business rules, Anti-IDOR, kiểm soát trạng thái, phân loại `EXPIRED` ngoài transaction.
  - `resident.controller.ts` — Express 5 handlers trích xuất `res.locals.currentUser`, validate, gọi Service, trả JSON.
  - `resident.routes.ts` — Đăng ký 7 route với `requireRole(...)`.

### 8.2. Chiến lược Kiểm thử (`tests/residents/`)
1. `tests/residents/resident.validation-mapper.test.ts` — Unit tests cho Zod validation (email/phone/UUID rejection/extra fields/pagination) & DTO mapper (kiểm tra không bao giờ xuất `passwordHash`/`email`/`phone`).
2. `tests/residents/resident.service.test.ts` — Unit tests (mock Repository) cho toàn bộ nhánh lỗi, phân quyền Anti-IDOR, transaction outcome `EXPIRED`, và kiểm tra tĩnh đảm bảo `resident.service.ts` không import `prisma`.
3. `tests/residents/resident-api.test.ts` — HTTP tests qua `http.createServer(app)` kiểm tra Auth/RBAC (`401`, `403 ACCOUNT_LOCKED`, `403 FORBIDDEN`), `400 VALIDATION_ERROR`, status codes `200`/`201`/`404`/`409`.
4. `tests/residents/resident-db.integration.test.ts` — **PostgreSQL Live DB Integration Tests:**
   - **Concurrency `/accept` (`BR-11`):** Phòng `maxOccupants = 2` (1 Primary Tenant + 1 slot trống), gửi 2 lời mời cho user B và user C cùng lúc, cả 2 gọi `/accept` song song qua `Promise.all` → đúng 1 request trả `200 OK` và 1 request trả `409 ROOM_CAPACITY_EXCEEDED`, DB có đúng 1 `ContractResident` active (`currentOccupants = 2`).
   - **Concurrency `POST /invitations`:** Chủ HĐ và Chủ trọ cùng gọi `POST /invitations` song song cho cùng 1 người được mời → `[201, 409 INVITATION_ALREADY_PENDING]`, DB chỉ có 1 lời mời `PENDING`.
   - **Composite PK Upsert (Rejoin):** Gỡ user B (`DELETE` → `leftAt != null`) → mời lại → user B `/accept` lại thành công `200 OK`, `leftAt` trở về `null`, không lỗi trùng `@@id([contractId, userId])`.
   - **Lazy Expiration Persistence:** Tạo lời mời có `expiresAt` trong quá khứ → gọi `/accept`, `/reject`, `/cancel` đều trả `409 INVITATION_EXPIRED` VÀ kiểm tra trực tiếp DB xác nhận `status` đã thực sự commit thành `'EXPIRED'` (không bị rollback).
   - **BR-10 & Self-leave & Notifications/AuditLog:** Cấm xóa Chủ HĐ (`400 CANNOT_REMOVE_PRIMARY_TENANT`), `CO_RESIDENT` gỡ người khác (`403`), `CO_RESIDENT` tự rời phòng (`200`), kiểm tra đủ 3 bản ghi `Notification` (`RESIDENT_REMOVED`) cho Chủ trọ + Chủ HĐ + Người ở cùng và đủ bản ghi `AuditLog`.
   - **Anti-IDOR:** Outsider & Former Co-Resident (`leftAt != null`) gọi các endpoint hợp đồng/lời mời đều nhận `404`.

---

## 9. Quyết định đã chốt sau `grill-me` (Cổng duyệt #1 — 2026-11-22)

Toàn bộ 4 điểm kỹ thuật/contract sau đã được Owner phê duyệt chính thức và khóa cứng cho giai đoạn triển khai (`Feature Builder`):

| # | Chủ đề | Quyết định đã chốt (Final) |
|---|---|---|
| 1 | Người nhận Notification `RESIDENT_INVITATION_REJECTED` | Chỉ gửi cho **người gửi lời mời (`invitation.invitedById`)** để tránh spam thông báo. |
| 2 | Hiển thị PII (`email` / `phone`) trong response DTO | Áp dụng **Privacy-by-Default**: chỉ trả `{ id, fullName, avatarUrl }` (hoặc `{ userId, fullName, avatarUrl }`), ẩn hoàn toàn `email` và `phone`. |
| 3 | Trường `pendingInvitations` khi `CO_RESIDENT` gọi `GET /contracts/:contractId/residents` | Trả tường minh `pendingInvitations: null` (phân biệt rõ không có quyền xem với mảng rỗng `[]` ở góc nhìn Chủ HĐ / Chủ trọ). |
| 4 | Hành vi khi hợp đồng không còn `ACTIVE` (`LIQUIDATING` / `TERMINATED` / ...) | Vẫn cho phép `GET /contracts/:contractId/residents` (trả kèm `contractStatus`) và cho phép `PATCH /resident-invitations/:invitationId/reject`, `PATCH /resident-invitations/:invitationId/cancel` để dọn lời mời `PENDING` còn hạn; giữ `409 CONTRACT_NOT_ACTIVE` cho `POST /invitations`, `PATCH /accept` và `DELETE /residents/:userId`. |
