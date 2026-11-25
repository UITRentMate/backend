# Technical Design Specification: Báo cáo Sự cố / Sửa chữa, Nghiệm thu & Luật bảo vệ 72h / 5 ngày (BE-P3-09)

- **Mã Issue:** `UITRentMate/backend#38` (`[BE-P3-09] Báo cáo Sự cố / Sửa chữa, Nghiệm thu & Luật bảo vệ 72h / 5 ngày (BP-08)`)
- **Tác giả:** Feature Architect (đối chiếu yêu cầu đã chốt giữa Owner & Team Lead qua `grill-me` Cổng duyệt #1)
- **Ngày lập:** 2026-11-24
- **Nhánh làm việc:** `feat/be-p3-09-repair-tickets` (tách từ `origin/staging` @ `f47a82f`)
- **Module mục tiêu:** `src/modules/repair-tickets/`
- **Đặc tả OpenAPI 3.1:** [docs/openapi/repair-tickets.yaml](../../openapi/repair-tickets.yaml)
- **Kế hoạch triển khai:** [docs/superpowers/plans/2026-11-24-repair-tickets.md](../plans/2026-11-24-repair-tickets.md)
- **Trạng thái:** `Approved (Refine Final — 2026-11-24)`

---

## 1. Mục tiêu Nghiệp vụ & Phạm vi

Xây dựng phân hệ **Báo cáo Sự cố / Sửa chữa, Nghiệm thu & Luật bảo vệ 72 giờ / 5 ngày** (`BP-08`, `BR-10`, `UC-25`) cho nền tảng RentMate với 7 endpoint P0:

1. **Báo cáo sự cố kèm bằng chứng hiện trường (`POST /api/v1/repair-tickets` — `BR-10`):**
   - Cho phép **Chủ hợp đồng (`contract.tenantId`)** hoặc **Người ở cùng đang cư trú (`ContractResident.leftAt IS NULL`)** thuộc hợp đồng `ACTIVE` tạo phiếu sự cố cho **phòng riêng** (`roomId` có giá trị) hoặc **khu vực chung** của khu trọ (`roomId = null`, truyền `propertyId`).
   - Bắt buộc đính kèm **1–5 ảnh hiện trường** (`stage = 'INITIAL'`, `multipart/form-data`, `memoryStorage`, tối đa 5MB/ảnh, xác thực MIME + Magic Bytes `JPEG/PNG/WEBP`).
2. **Tra cứu danh sách & chi tiết sự cố theo quyền cư trú hiện tại (`GET /api/v1/repair-tickets`, `GET /api/v1/repair-tickets/:ticketId`):**
   - Lọc theo `status`, `priority`, `propertyId`, `roomId`, phân trang chuẩn (`page` 1..10000, `limit`/`pageSize` 1..50).
   - Chạy lazy auto-close có phạm vi (tối đa 50 ticket thuộc phạm vi người gọi) trước khi truy vấn danh sách để bộ lọc `?status=` luôn khớp tức thời.
   - Trả chi tiết ảnh theo `stage` (`INITIAL`, `COMPLETION`, `REOPEN_EVIDENCE`), lịch sử mở lại (`reopenHistory` / `latestRejectionReason`), cờ bảo vệ 72 giờ (`canEscalateToComplaint`), và mốc tự động đóng 5 ngày (`autoCloseAt`) trên cả list item lẫn detail DTO.
3. **Tiếp nhận & Báo hoàn tất sửa chữa của Chủ trọ (`PATCH /accept`, `PATCH /complete`):**
   - Chỉ `LANDLORD` sở hữu khu trọ (`property.landlordId === currentUser.id`) mới được thao tác (`404` nếu của chủ trọ khác).
   - Tiếp nhận (`OPEN → IN_PROGRESS`) với `resolutionPlan` và `scheduledAt` (`>= now - 5 phút`).
   - Báo hoàn tất (`IN_PROGRESS → AWAITING_CONFIRMATION`) bắt buộc kèm **1–5 ảnh kết quả** (`stage = 'COMPLETION'`), tùy chọn cặp `repairCost` (`>= 0`) & `costBearer` (`LANDLORD | TENANT`).
4. **Nghiệm thu đạt / chưa đạt của phía Người thuê (`PATCH /confirm-completion`, `PATCH /reject-completion`):**
   - **Phòng riêng (`roomId != null`):** Mọi thành viên đang cư trú `ACTIVE` tại hợp đồng `ACTIVE` hiện tại của phòng (Chủ hợp đồng + tất cả `ContractResident` `leftAt IS NULL`) đều có quyền nghiệm thu.
   - **Khu vực chung (`roomId = null`):** Chỉ `createdById` **VÀ phải đang còn cư trú `ACTIVE`** tại ít nhất 1 hợp đồng thuộc `propertyId` đó mới được nghiệm thu.
   - Nghiệm thu đạt (`AWAITING_CONFIRMATION → CLOSED`, `closedAt = now()`).
   - Nghiệm thu chưa đạt (`AWAITING_CONFIRMATION → IN_PROGRESS`, `completedAt = null`, `repairCost = null`, `costBearer = null`) kèm `reason` (10–1000 ký tự) và tùy chọn **0–3 ảnh đối chứng** (`stage = 'REOPEN_EVIDENCE'`), hỗ trợ cả `multipart/form-data` lẫn `application/json`, không giới hạn số lần mở lại.
5. **Luật bảo vệ 72 giờ & 5 ngày (`BP-08`):**
   - **72h chưa tiếp nhận:** Tính động `canEscalateToComplaint = (status === 'OPEN' && now - createdAt >= 72h)` (`PHASE3_TIME_LIMITS_MS.REPAIR_ESCALATION_WAIT_MS`).
   - **5 ngày tự động đóng (`autoCloseStaleRepairTickets`):** Ticket `AWAITING_CONFIRMATION` có `completedAt + 5 ngày <= now` tự động chuyển `CLOSED`, `closedAt = now()`, gửi `Notification` cho Chủ trọ và các thành viên cư trú `ACTIVE` tương ứng, và ghi `AuditLog`. Dùng chung cho cả **lazy-check** lẫn **scheduler nội bộ** (`src/infrastructure/scheduler/phase3-timers.ts`, chu kỳ 15 phút, batch 100).

### Ngoài phạm vi (Out of Scope)
- Tạo khiếu nại chính thức lên Admin (`Complaint` — Phase 5).
- Tự động đẩy `repairCost` vào hóa đơn hàng tháng (Phase 4).
- Chỉnh sửa `prisma/schema.prisma` hoặc tạo migration mới (Zero DB Schema Drift).

---

## 2. Đối chiếu Schema, Hằng số & Chống xung đột PR đang mở

### 2.1. Zero DB Schema Drift — Các ràng buộc thực tế từ `prisma/schema.prisma` (`f47a82f`)

Toàn bộ 4 cột mới của Phase 3 (`priority`, `resolution_plan`, `repair_cost`, `cost_bearer`) và index `repair_tickets_property_id_status_idx` đã tồn tại từ PR #39 (`20261121060000_phase3_shared_schema`):

| Bảng / Model | Cột & Ràng buộc thực tế | Hệ quả thiết kế bắt buộc |
|---|---|---|
| `RepairTicket` (`repair_tickets`) | `id (Uuid)`, `propertyId (Uuid)`, `roomId (Uuid?)`, `createdById (Uuid)`, `title VarChar(200)`, `description Text`, `priority VarChar(20) default 'MEDIUM'`, `status VarChar(28)`, `resolutionPlan Text?`, `repairCost Decimal(14,2)?`, `costBearer VarChar(20)?`, `scheduledAt Timestamptz?`, `completedAt Timestamptz?`, `closedAt Timestamptz?`, `createdAt Timestamptz`, `@@index([propertyId, status])` | - **Không có `updatedAt`, không có `contractId`, không có cột `rejectionReason`/`reopenCount`.**<br>- `repairCost` kiểu `Decimal(14, 2)` ⇒ giá trị tối đa `999_999_999_999.99`, khi map ra DTO chuyển sang `number \| null`.<br>- Không có index riêng trên `(status, completedAt)` (giữ Zero DB Schema Drift; cron giới hạn batch `take: 100` sắp xếp `completedAt ASC, id ASC`). |
| `RepairAttachment` (`repair_attachments`) | `id (Uuid)`, `ticketId (Uuid)`, `uploadedById (Uuid)`, `fileUrl Text` (**NOT NULL**), `stage VarChar(25)`, `reason Text?` | - **KHÔNG có cột `createdAt`** ⇒ sắp xếp cố định theo `id ASC` (và gom nhóm theo `stage`).<br>- **`fileUrl` là `NOT NULL` (`String`)** ⇒ **KHÔNG ĐƯỢC** tạo dòng `RepairAttachment` giả với `fileUrl = ''` khi Tenant `reject-completion` với `0` ảnh. Khi `reject-completion` có 1–3 ảnh thì lưu `reason` vào từng `RepairAttachment` (`stage = 'REOPEN_EVIDENCE'`); đồng thời **luôn** lưu `reason` vào `AuditLog` (`action = 'REPAIR_TICKET_REOPENED'`) + `Notification.payload` để `GET /:ticketId` luôn trả được `latestRejectionReason` và `reopenHistory` kể cả khi 0 ảnh. |
| `Contract` & `ContractResident` | `Contract.status VarChar(32)`, `Contract.tenantId`, `Contract.roomId`; `ContractResident(contractId, userId, joinedAt, leftAt)` | Tư cách cư trú `ACTIVE`: `contract.status === 'ACTIVE'` và (`contract.tenantId === userId` HOẶC tồn tại `ContractResident` có `userId` và `leftAt IS NULL`). Dùng `SELECT id FROM contracts WHERE id = $1::uuid FOR UPDATE` trong `POST /repair-tickets` để chống TOCTOU nếu hợp đồng bị chấm dứt/gỡ cư dân đồng thời. |
| `Notification` (`notifications`) | `title VarChar(200)`, `eventType VarChar(40)`, `payload JsonB`, `@@index([recipientId, isRead, createdAt DESC])` | Mọi tiêu đề dùng helper `formatNotificationTitle(..., 160)` (an toàn dưới 200 code points); payload theo chuẩn `NotificationPayload` PR #40 (`content`, `actionUrl`, `relatedEntityType`, `relatedEntityId`, `metadata`). |
| `AuditLog` (`audit_logs`) | `actorId Uuid?`, `entityType VarChar(60)`, `entityId Uuid`, `action VarChar(60)`, `oldData JsonB?`, `newData JsonB?` | `actorId = null` cho tác vụ hệ thống (`REPAIR_TICKET_AUTO_CLOSED`), `entityType = 'REPAIR_TICKET'`, `entityId = ticket.id`. |

### 2.2. Đối chiếu `src/common/constants/phase3-status.ts`

Toàn bộ hằng số đã có đầy đủ trên `origin/staging` — **KHÔNG CẦN SỬA `phase3-status.ts`**:
- `REPAIR_TICKET_STATUS`: `OPEN`, `IN_PROGRESS`, `AWAITING_CONFIRMATION`, `CLOSED`
- `REPAIR_TICKET_PRIORITY`: `LOW`, `MEDIUM`, `HIGH`, `URGENT`
- `REPAIR_COST_BEARER`: `LANDLORD`, `TENANT`
- `REPAIR_ATTACHMENT_STAGE`: `INITIAL`, `COMPLETION`, `REOPEN_EVIDENCE`
- `NOTIFICATION_EVENT_TYPE` (đã ánh xạ sẵn sang `NOTIFICATION_CATEGORY.REPAIR` trong `NOTIFICATION_CATEGORY_BY_EVENT`):
  `REPAIR_TICKET_CREATED`, `REPAIR_TICKET_ACCEPTED`, `REPAIR_TICKET_COMPLETED`, `REPAIR_TICKET_REOPENED`, `REPAIR_TICKET_CLOSED`
- `PHASE3_TIME_LIMITS_MS`: `REPAIR_ESCALATION_WAIT_MS` (72h), `REPAIR_AUTO_CLOSE_WAIT_MS` (5 ngày)

### 2.3. Kiến trúc Phân tầng theo `AGENTS.md §2.2` (Chuẩn PR #40 / #41)

```text
Request ──► repair-ticket.routes.ts (requireRole, uploadRepairAttachments)
              ──► repair-ticket.controller.ts (trích currentUser, validate Zod, gọi Service, trả HTTP JSON)
                    ──► repair-ticket.service.ts (Business Logic, Cloudinary Upload/Rollback ngoài tx,
                                                  prisma.$transaction, RE-CHECK quyền & trạng thái SAU lock FOR UPDATE,
                                                  ApiError, createNotification/Batch, recordAuditLog, Mapper)
                          ──► repair-ticket.repository.ts (lockTicketRow / lockTicketRowSkipLocked / lockContractRow
                                                           và persistence/query Prisma thuần — KHÔNG ApiError/Notification/AuditLog/$transaction)
                                ──► PostgreSQL
```

- **`repair-ticket.repository.ts`:** Chỉ chứa truy vấn đọc, các hàm ghi nhận `tx: Prisma.TransactionClient`, và 3 hàm khóa hàng (`lockTicketRow`, `lockTicketRowSkipLocked`, `lockContractRow`). Tuyệt đối không ném `ApiError`, không gọi `createNotification`/`recordAuditLog`, không tự mở `prisma.$transaction`.
- **`repair-ticket.service.ts`:** Giữ toàn bộ nghiệp vụ, điều phối `prisma.$transaction`, **re-check quyền cư trú/sở hữu & trạng thái sau khi khóa `FOR UPDATE`**, xử lý rollback Cloudinary khi transaction lỗi, và điều phối `autoCloseStaleRepairTickets`.

### 2.4. Kiểm soát Xung đột với PR đang mở (`#42` & `#43`)

| File ngoài `src/modules/repair-tickets/` | Thay đổi trên nhánh `feat/be-p3-09-repair-tickets` | Tương tác với PR #42 & PR #43 |
|---|---|---|
| `src/app.ts` | Thêm đúng 1 dòng import `repairTicketRouter` (alphabet sau `rentalRequestRouter`) và 1 dòng `app.use(repairTicketRouter);` ở cuối nhóm router. | PR #42 thêm `contractRouter` ở vị trí khác ⇒ xung đột tối thiểu/dễ gộp. |
| `src/infrastructure/scheduler/phase3-timers.ts` | Thêm hàm `registerRepairTicketAutoCloseJob()` ở cuối file (chu kỳ 15 phút cho `autoCloseStaleRepairTickets`). | PR #42 thêm `registerContractHoldExpiryJob()` gần đầu file ⇒ đặt cuối file hạn chế overlap. |
| `src/server.ts` | Import và gọi `registerRepairTicketAutoCloseJob();` ngay trước `app.listen(...)`. | PR #42 sửa cùng cụm 2 dòng này để gọi `registerContractHoldExpiryJob()` ⇒ lưu ý gộp sạch khi rebase/merge sau PR #42. |
| `src/common/utils/cloudinary.util.ts` | **KHÔNG CHẠM.** `buildRepairAttachmentPublicId` đặt trong `repair-ticket.upload.ts`; chỉ import `validateUploadedImageFile`. | 0 xung đột với PR #43. |
| `src/modules/media/*` | **KHÔNG CHẠM.** `uploadRepairAttachments` đặt cục bộ trong `repair-ticket.upload.ts`; chỉ tái sử dụng `mediaService`. | 0 xung đột với PR #43. |
| `src/common/constants/phase3-status.ts` & `prisma/schema.prisma` | **KHÔNG CHẠM.** | 0 xung đột (Zero DB Schema Drift). |

---

## 3. Vòng đời Trạng thái, Upload Cloudinary & Concurrency

### 3.1. State Machine (`BP-08`)

```text
  OPEN ────(Landlord PATCH /accept: resolutionPlan, scheduledAt >= now - 5m)────► IN_PROGRESS
   │                                                                                 │    ▲
   │ [now - createdAt >= 72h:                                                        │    │ (Tenant PATCH /reject-completion:
   │  DTO trả canEscalateToComplaint = true]                                         │    │  reason + 0..3 ảnh REOPEN_EVIDENCE,
   │                                                                                 ▼    │  reset completedAt/repairCost/costBearer = null)
   │                               (Landlord PATCH /complete: 1..5 ảnh COMPLETION, repairCost?, costBearer?)
   │                                                                      AWAITING_CONFIRMATION
   │                                                                        /                \
   │                                          (Tenant PATCH /confirm-completion)       (completedAt + 5 ngày <= now:
   │                                                         ▼                          lazy-check + phase3-timers)
   │                                                      CLOSED ◄────────────────────────────┘
```

- `CLOSED` là **trạng thái cuối bất biến (immutable)** — mọi thao tác ghi trên ticket đã `CLOSED` trả `409 REPAIR_TICKET_ALREADY_CLOSED`.
- Bảng chuyển trạng thái hợp lệ:
  - `accept`: chỉ từ `OPEN` → `IN_PROGRESS`.
  - `complete`: chỉ từ `IN_PROGRESS` → `AWAITING_CONFIRMATION` (`completedAt = now()`, lưu `repairCost`, `costBearer`).
  - `confirm-completion`: chỉ từ `AWAITING_CONFIRMATION` (còn trong hạn 5 ngày) → `CLOSED` (`closedAt = now()`).
  - `reject-completion`: chỉ từ `AWAITING_CONFIRMATION` (còn trong hạn 5 ngày) → `IN_PROGRESS` (`completedAt = null`, `repairCost = null`, `costBearer = null`; giá trị cũ được lưu nguyên vẹn trong `AuditLog.oldData`). Không giới hạn số lần mở lại.
  - `autoClose`: chỉ từ `AWAITING_CONFIRMATION` khi `completedAt + 5 ngày <= now` → `CLOSED` (`closedAt = now()`).

### 3.2. Chiến lược Upload Ảnh An toàn (All-or-Nothing + Cloudinary Rollback)

Áp dụng cho cả 3 endpoint có upload ảnh (`POST /repair-tickets` 1–5 ảnh, `PATCH /complete` 1–5 ảnh, `PATCH /reject-completion` 0–3 ảnh):

1. **Tầng Middleware (`repair-ticket.upload.ts`):**
   - Dùng `multer.memoryStorage()`, `limits: { fileSize: 5 * 1024 * 1024 }` (5 MiB/ảnh), tên trường `attachments`.
   - Với `PATCH /reject-completion`: hỗ trợ cả `multipart/form-data` (0–3 ảnh) lẫn `application/json` (0 ảnh; nếu `req.is('application/json')` thì bỏ qua Multer và gán `req.files = []`).
   - Ánh xạ lỗi Multer chuẩn `ApiError`:
     - `LIMIT_FILE_SIZE` → `413 FILE_TOO_LARGE`
     - `LIMIT_UNEXPECTED_FILE` (đúng field `attachments` vượt `maxCount`) → `400 ATTACHMENT_LIMIT_EXCEEDED`
     - `LIMIT_UNEXPECTED_FILE` (sai tên field) → `400 INVALID_FILE_UPLOAD`
   - Kiểm tra số lượng tối thiểu (`files.length < minFiles` → `400 ATTACHMENTS_REQUIRED`).
   - Kiểm tra **từng file** bằng `validateUploadedImageFile(file.mimetype, file.buffer)` (MIME + Magic Bytes `JPEG/PNG/WEBP`). Nếu bất kỳ file nào không hợp lệ → reject ngay `415 UNSUPPORTED_MEDIA_TYPE` **trước khi gọi DB hoặc Cloudinary**.
2. **Tầng Service — Luồng 4 bước chống rác ảnh & chống giữ DB lock khi I/O mạng:**
   - **Bước 1 (Validate & Pre-check DB không giữ lock):** Validate toàn bộ text fields bằng Zod; đọc nhẹ quyền/trạng thái hiện tại. Nếu không có quyền (`404`) hoặc sai trạng thái (`409`), dừng ngay — **0 ảnh bị upload lên Cloudinary**.
   - **Bước 2 (Upload Cloudinary NGOÀI `$transaction`):**
     - Upload từng file qua `mediaService.uploadStream(file.buffer, { publicId })` với `publicId = rentmate/repairs/${propertyId}/${ticketId}/${stage.toLowerCase()}_${attachmentId}`.
     - Ghi nhận `uploadedPublicIds[]` sau mỗi file thành công; nếu file thứ `k` thất bại → dọn dẹp ngay toàn bộ `uploadedPublicIds` đã upload bằng `Promise.allSettled(uploadedPublicIds.map(id => mediaService.deleteResource(id)))` và ném `502 CLOUDINARY_UPLOAD_FAILED`.
   - **Bước 3 (Ghi DB trong `prisma.$transaction` + Row Lock + Re-check):**
     - Khóa hàng (`lockContractRow` cho `POST`, `lockTicketRow` cho `PATCH /complete` & `PATCH /reject-completion`).
     - **Re-check lại quyền cư trú `ACTIVE` / quyền sở hữu & trạng thái SAU khi khóa** (chống TOCTOU & race condition với `autoCloseStaleRepairTickets` / thao tác song song khác).
     - Ghi DB (`repairTicket`, `repairAttachment.createMany`, `createNotification`/`createNotificationsBatch`, `recordAuditLog`).
   - **Bước 4 (Compensating Rollback):**
     - Nếu `prisma.$transaction` ném bất kỳ lỗi nào (`404`, `409`, lỗi DB) HOẶC trả `{ outcome: 'AUTO_CLOSED' }`: chạy `await cleanupUploadedRepairFiles(uploadedPublicIds)` (`Promise.allSettled`, chỉ `console.warn` nếu xóa thất bại để không che lỗi gốc), rồi ném lỗi nghiệp vụ gốc (`ApiError`) hoặc `409 REPAIR_TICKET_AUTO_CLOSED`.

### 3.3. Chống Race Condition & Bẫy Rollback Lazy Auto-Close

1. **Khóa hàng theo thứ tự duy nhất (Zero Deadlock):**
   - `POST /repair-tickets`: Khóa `contracts` (`SELECT id FROM contracts WHERE id = ${contractId}::uuid FOR UPDATE`) → re-check `contract.status === 'ACTIVE'` và caller là Primary Tenant hoặc `ContractResident` (`leftAt IS NULL`) → tạo `RepairTicket` + `RepairAttachment` + `Notification` + `AuditLog`.
   - `PATCH /accept`, `PATCH /complete`, `PATCH /confirm-completion`, `PATCH /reject-completion`: Khóa `repair_tickets` (`SELECT id FROM repair_tickets WHERE id = ${ticketId}::uuid FOR UPDATE`) → **re-check quyền sở hữu / quyền cư trú `ACTIVE` (theo Q1)** + re-check `status` + kiểm tra hạn 5 ngày → cập nhật + `Notification` + `AuditLog`.
2. **Xử lý Bẫy Transaction Rollback khi Lazy Auto-Close 5 ngày (Q6):**
   - Trong `PATCH /confirm-completion` và `PATCH /reject-completion`, nếu dưới khóa `FOR UPDATE` (sau khi đã re-check quyền cư trú `ACTIVE`) phát hiện `ticket.status === 'AWAITING_CONFIRMATION'` và `ticket.completedAt !== null && now.getTime() - ticket.completedAt.getTime() >= REPAIR_AUTO_CLOSE_WAIT_MS`:
     1. Cập nhật ngay trong `tx`: `status = 'CLOSED'`, `closedAt = now`.
     2. Ghi `Notification` (`REPAIR_TICKET_CLOSED`, `metadata.autoClosed = true`) theo ma trận Mục 6.1 và ghi `AuditLog` (`actorId = null`, `action = 'REPAIR_TICKET_AUTO_CLOSED'`).
     3. **Trả về `{ outcome: 'AUTO_CLOSED' }`** để `prisma.$transaction` **COMMIT** trạng thái `CLOSED`.
     4. Ở ngoài `tx`: dọn sạch ảnh `REOPEN_EVIDENCE` vừa upload (nếu có trong `reject-completion`) rồi ném **`409 REPAIR_TICKET_AUTO_CLOSED`**.
3. **Thiết kế `autoCloseStaleRepairTickets` cho Cron & Lazy-Check (Q8, Q9):**
   - **Batch cron (`autoCloseStaleRepairTickets({ now, batchSize = 100 })`):**
     - Truy vấn tối đa `batchSize` ticket IDs có `status = 'AWAITING_CONFIRMATION'` và `completedAt <= cutoff`, sắp xếp `completedAt ASC, id ASC`.
     - Duyệt từng `ticketId` trong `try / catch` độc lập, mở `prisma.$transaction` riêng cho từng bản ghi:
       - Gọi `lockTicketRowSkipLocked(tx, ticketId)` (`FOR UPDATE SKIP LOCKED`) → nếu đang bị khóa bởi request nghiệm thu của người dùng thì bỏ qua (`skippedCount++`).
       - Re-check `ticket.status === 'AWAITING_CONFIRMATION' && ticket.completedAt !== null && ticket.completedAt <= cutoff` → nếu đã đổi trạng thái thì bỏ qua (`skippedCount++`, idempotent 100%).
       - Cập nhật `status = 'CLOSED', closedAt = now`, tạo `Notification` theo Mục 6.1, ghi `AuditLog` (`actorId: null`, `action: 'REPAIR_TICKET_AUTO_CLOSED'`).
     - Nếu 1 bản ghi gặp lỗi → `console.error({ ticketId, error })`, `failedCount++`, và **tiếp tục xử lý các bản ghi còn lại trong batch**.
     - Trả về `{ scanned, closedCount, skippedCount, failedCount }`.
   - **Single-ticket lazy-check (`autoCloseSingleTicketIfStale(ticketId, now)`):**
     - Dùng trong `GET /api/v1/repair-tickets/:ticketId` khi thấy `AWAITING_CONFIRMATION` đã quá 5 ngày. Dùng `lockTicketRow(tx, ticketId)` (`FOR UPDATE`), re-check và commit idempotently.
   - **Scoped list lazy-check (`GET /api/v1/repair-tickets`):**
     - Gọi `autoCloseStaleRepairTickets({ now, batchSize: 50, extraWhere: scopeWhere })` trước khi thực thi `findMany` + `count`, bảo đảm lọc `?status=AWAITING_CONFIRMATION` và `?status=CLOSED` chính xác ngay sau mốc 5 ngày.

---

## 4. Ma trận Phân quyền, Anti-IDOR & Bảo mật (Chốt Q1)

### 4.1. Định nghĩa Quyền truy cập & Nghiệm thu (Q1)
- **`LANDLORD`:** Xem tất cả ticket thuộc khu trọ mình sở hữu (`property.landlordId === currentUser.id`); chỉ `LANDLORD` sở hữu khu trọ mới được `accept` / `complete`; bị chặn `403 FORBIDDEN` ở `POST`, `confirm-completion`, `reject-completion`.
- **`TENANT` đối với sự cố gắn phòng (`roomId != null`):**
  - Mọi thành viên đang cư trú `ACTIVE` theo hợp đồng `ACTIVE` hiện tại của `roomId` (**Chủ hợp đồng `contract.tenantId` + tất cả `ContractResident` có `leftAt IS NULL`**) đều có quyền **xem (`GET /`, `GET /:ticketId`) VÀ nghiệm thu (`PATCH /confirm-completion`, `PATCH /reject-completion`)**.
  - Nếu người tạo (`createdById`) hoặc thành viên cũ **đã rời phòng (`leftAt != null`) hoặc hợp đồng không còn `ACTIVE`** → **cắt cả quyền xem lẫn quyền nghiệm thu** (`GET /:ticketId`, `confirm-completion`, `reject-completion` trả `404 REPAIR_TICKET_NOT_FOUND`; `GET /repair-tickets` không trả các ticket của phòng đó).
- **`TENANT` đối với sự cố khu vực chung (`roomId = null`, gắn `propertyId`):**
  - **Xem (`GET /`, `GET /:ticketId`):** Mọi Tenant đang có ít nhất 1 hợp đồng `ACTIVE` thuộc `propertyId` (`contract.tenantId === currentUser.id` hoặc `ContractResident.leftAt IS NULL`) đều được xem. Nếu rời khu trọ (không còn hợp đồng `ACTIVE` nào tại `propertyId`) → cắt cả quyền xem (`404`) lẫn nghiệm thu (`404`).
  - **Nghiệm thu (`PATCH /confirm-completion`, `PATCH /reject-completion`):** Chỉ **`createdById` VÀ phải đang còn cư trú `ACTIVE` tại ít nhất 1 hợp đồng thuộc `propertyId` đó** mới được nghiệm thu; người thuê khác cùng khu trọ nhận `404 REPAIR_TICKET_NOT_FOUND`.
- **Phạm vi truy vấn `GET /api/v1/repair-tickets` cho `TENANT`:**
  - Chỉ lọc trong `{ OR: [{ roomId: { in: activeRoomIds } }, { roomId: null, propertyId: { in: activePropertyIds } }] }` (nếu cả 2 tập rỗng → trả ngay `{ items: [], total: 0, page, limit, totalPages: 0 }`).

### 4.2. Bảng Phân quyền theo Endpoint

| Endpoint | Middleware | Chủ HĐ phòng (`ACTIVE`) | Người ở cùng phòng (`ACTIVE`) | Tenant khác cùng khu trọ (`ACTIVE`) | Former Resident / HĐ hết `ACTIVE` (kể cả `createdById`) | Landlord sở hữu khu trọ | Landlord khu trọ khác | Admin | Account khóa |
|---|---|---|---|---|---|---|---|---|---|
| `POST /repair-tickets` (phòng riêng) | `requireRole('TENANT')` | `201` | `201` | `404` | `404` | `403` | `403` | `403` | `403 ACCOUNT_LOCKED` |
| `POST /repair-tickets` (khu chung `roomId=null`) | `requireRole('TENANT')` | `201` | `201` | `201` | `404` | `403` | `403` | `403` | `403 ACCOUNT_LOCKED` |
| `GET /repair-tickets` | `requireRole('TENANT', 'LANDLORD')` | `200` (phòng mình + khu chung) | `200` (phòng mình + khu chung) | `200` (phòng mình + khu chung) | `200` (`items: []` nếu không còn HĐ `ACTIVE`) | `200` (khu trọ sở hữu) | `200` (chỉ khu trọ của mình) | `403` | `403 ACCOUNT_LOCKED` |
| `GET /repair-tickets/:ticketId` (phòng riêng) | `requireRole('TENANT', 'LANDLORD')` | `200` | `200` | `404` | `404` | `200` | `404` | `403` | `403 ACCOUNT_LOCKED` |
| `GET /repair-tickets/:ticketId` (khu chung) | `requireRole('TENANT', 'LANDLORD')` | `200` | `200` | `200` | `404` | `200` | `404` | `403` | `403 ACCOUNT_LOCKED` |
| `PATCH /repair-tickets/:ticketId/accept` | `requireRole('LANDLORD')` | `403` | `403` | `403` | `403` | `200` | `404` | `403` | `403 ACCOUNT_LOCKED` |
| `PATCH /repair-tickets/:ticketId/complete` | `requireRole('LANDLORD')` | `403` | `403` | `403` | `403` | `200` | `404` | `403` | `403 ACCOUNT_LOCKED` |
| `PATCH /repair-tickets/:ticketId/confirm-completion` (phòng riêng) | `requireRole('TENANT')` | `200` | `200` | `404` | `404` | `403` | `403` | `403` | `403 ACCOUNT_LOCKED` |
| `PATCH /repair-tickets/:ticketId/confirm-completion` (khu chung) | `requireRole('TENANT')` | `200` nếu là `createdById` / `404` | `200` nếu là `createdById` / `404` | `200` nếu là `createdById` / `404` | `404` | `403` | `403` | `403` | `403 ACCOUNT_LOCKED` |
| `PATCH /repair-tickets/:ticketId/reject-completion` (phòng riêng) | `requireRole('TENANT')` | `200` | `200` | `404` | `404` | `403` | `403` | `403` | `403 ACCOUNT_LOCKED` |
| `PATCH /repair-tickets/:ticketId/reject-completion` (khu chung) | `requireRole('TENANT')` | `200` nếu là `createdById` / `404` | `200` nếu là `createdById` / `404` | `200` nếu là `createdById` / `404` | `404` | `403` | `403` | `403` | `403 ACCOUNT_LOCKED` |

### 4.3. Nguyên tắc Bảo mật Bắt buộc (`security-review`)
1. **Anti-IDOR chuẩn `404`:** Mọi truy cập vượt quyền sở hữu/cư trú trong cùng vai trò trả thống nhất `404 REPAIR_TICKET_NOT_FOUND` (hoặc `404 ROOM_NOT_FOUND` / `404 PROPERTY_NOT_FOUND` khi tạo mới).
2. **Suy diễn `propertyId` phía Server:** Khi tạo sự cố phòng riêng (`roomId` có giá trị), luôn suy ra `propertyId` từ `room.propertyId` trong DB; nếu client truyền kèm `propertyId` khác `room.propertyId` → trả `404 ROOM_NOT_FOUND`.
3. **Privacy-by-Default:** Mọi truy vấn `User` dùng explicit `select: { id: true, fullName: true, avatarUrl: true }` — tuyệt đối không select hay trả `passwordHash`, `password_hash`, `email`, `phone`.
4. **Chống SQL Injection & DoS phân trang:** Mọi raw SQL khóa hàng dùng Prisma tagged template parameterized (`tx.$queryRaw\`... ${id}::uuid ...\``); giới hạn cứng `page <= 10_000`, `limit <= 50`.
5. **Chống giả mạo file upload:** Xác thực đồng thời `Content-Type` MIME và Magic Bytes nhị phân (`JPEG`, `PNG`, `WebP`) qua `validateUploadedImageFile`, tối đa 5MB/file ngay tại `multer.memoryStorage()`.

---

## 5. Đặc tả Chi tiết 7 Endpoints & Validation Biên

> Chi tiết schema đầy đủ, ví dụ request/response và mã lỗi xem tại [docs/openapi/repair-tickets.yaml](../../openapi/repair-tickets.yaml).

### 5.1. Danh sách 7 Endpoints
| # | Method | Path | Auth | Content-Type | Success |
|---|---|---|---|---|---|
| 1 | `POST` | `/api/v1/repair-tickets` | `requireRole('TENANT')` | `multipart/form-data` | `201 Created` |
| 2 | `GET` | `/api/v1/repair-tickets` | `requireRole('TENANT', 'LANDLORD')` | — | `200 OK` |
| 3 | `GET` | `/api/v1/repair-tickets/:ticketId` | `requireRole('TENANT', 'LANDLORD')` | — | `200 OK` |
| 4 | `PATCH` | `/api/v1/repair-tickets/:ticketId/accept` | `requireRole('LANDLORD')` | `application/json` | `200 OK` |
| 5 | `PATCH` | `/api/v1/repair-tickets/:ticketId/complete` | `requireRole('LANDLORD')` | `multipart/form-data` | `200 OK` |
| 6 | `PATCH` | `/api/v1/repair-tickets/:ticketId/confirm-completion` | `requireRole('TENANT')` | — | `200 OK` |
| 7 | `PATCH` | `/api/v1/repair-tickets/:ticketId/reject-completion` | `requireRole('TENANT')` | `multipart/form-data` hoặc `application/json` | `200 OK` |

### 5.2. Quy tắc Validation Biên (Zod 4.6.7)
- **Path param `ticketId`:** Bắt buộc UUID hợp lệ (`UUID_REGEX`).
- **`POST /api/v1/repair-tickets` (`multipart/form-data`):**
  - `roomId?`: UUID hợp lệ (`""` → `undefined`).
  - `propertyId?`: UUID hợp lệ (`""` → `undefined`).
  - **Ràng buộc chéo:** Ít nhất 1 trong `roomId` hoặc `propertyId` phải có mặt (thiếu cả 2 → `400 VALIDATION_ERROR`).
  - `title`: `string.trim()`, độ dài `5..200` ký tự.
  - `description`: `string.trim()`, độ dài `10..2000` ký tự.
  - `priority?`: `LOW | MEDIUM | HIGH | URGENT` (mặc định `MEDIUM`).
  - `attachments`: bắt buộc **1–5 file ảnh**, mỗi file `<= 5MB`, MIME + Magic Bytes `JPEG/PNG/WEBP`.
- **`GET /api/v1/repair-tickets` (query):**
  - `status?`: `OPEN | IN_PROGRESS | AWAITING_CONFIRMATION | CLOSED`.
  - `priority?`: `LOW | MEDIUM | HIGH | URGENT`.
  - `propertyId?`: UUID hợp lệ.
  - `roomId?`: UUID hợp lệ.
  - `page`: số nguyên `1..10000`, mặc định `1`.
  - `limit`: số nguyên `1..50`, mặc định `20`.
  - `pageSize`: alias cho `limit` (`1..50`), nếu truyền cả 2 ưu tiên `limit`.
- **`PATCH /api/v1/repair-tickets/:ticketId/accept` (`application/json`, `.strict()`):**
  - `resolutionPlan`: `string.trim()`, độ dài `5..1000` ký tự.
  - `scheduledAt`: chuỗi ISO-8601 có timezone hợp lệ và **`scheduledAt.getTime() >= now.getTime() - 5 * 60 * 1000`** (cho phép lệch đồng hồ / bấm "sửa ngay" trong cửa sổ 5 phút — Q5).
- **`PATCH /api/v1/repair-tickets/:ticketId/complete` (`multipart/form-data`):**
  - `attachments`: bắt buộc **1–5 file ảnh**, mỗi file `<= 5MB`, MIME + Magic Bytes `JPEG/PNG/WEBP`.
  - `repairCost?`: số hữu hạn `>= 0` và `<= 999_999_999_999.99`, tối đa 2 chữ số thập phân (preprocess từ string multipart; `""` → `undefined`).
  - `costBearer?`: `LANDLORD | TENANT` (`""` → `undefined`).
  - **Ràng buộc chéo (Q3):** `repairCost` (`>= 0`, kể cả `0`) và `costBearer` bắt buộc đi cặp — có 1 thiếu 1 trả `400 VALIDATION_ERROR`.
- **`PATCH /api/v1/repair-tickets/:ticketId/confirm-completion`:**
  - Không yêu cầu request body.
- **`PATCH /api/v1/repair-tickets/:ticketId/reject-completion` (`multipart/form-data` hoặc `application/json`):**
  - `reason`: `string.trim()`, độ dài `10..1000` ký tự.
  - `attachments`: tùy chọn **0–3 file ảnh**, mỗi file `<= 5MB`, MIME + Magic Bytes `JPEG/PNG/WEBP`.

### 5.3. Bảng Mã Lỗi `ApiError` Chuẩn
| HTTP | `code` | Ngữ cảnh phát sinh |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Sai UUID, độ dài chuỗi, enum, `page`/`limit`, thiếu cả `roomId` & `propertyId`, `repairCost`/`costBearer` không đi cặp, `scheduledAt` sai định dạng hoặc nhỏ hơn `now - 5 phút` |
| `400` | `ATTACHMENTS_REQUIRED` | Thiếu ảnh bắt buộc (`POST` hoặc `PATCH /complete` gửi 0 ảnh) |
| `400` | `ATTACHMENT_LIMIT_EXCEEDED` | Số lượng ảnh vượt giới hạn (> 5 cho `POST`/`complete`, > 3 cho `reject-completion`) |
| `400` | `INVALID_FILE_UPLOAD` | Sai tên trường multipart (khác `attachments`) hoặc payload multipart lỗi |
| `401` | `UNAUTHORIZED` | Thiếu hoặc JWT Access Token không hợp lệ / hết hạn |
| `403` | `ACCOUNT_LOCKED` | Tài khoản không ở trạng thái `ACTIVE` |
| `403` | `FORBIDDEN` | Vai trò không được phép (`LANDLORD` gọi `POST`/`confirm`/`reject`; `TENANT` gọi `accept`/`complete`; `ADMIN` gọi bất kỳ endpoint nào) |
| `404` | `ROOM_NOT_FOUND` | `roomId` không tồn tại, không khớp `propertyId`, hoặc Tenant không có hợp đồng `ACTIVE` tại phòng (Anti-IDOR) |
| `404` | `PROPERTY_NOT_FOUND` | `propertyId` không tồn tại hoặc Tenant không có hợp đồng `ACTIVE` nào tại khu trọ (Anti-IDOR) |
| `404` | `REPAIR_TICKET_NOT_FOUND` | Ticket không tồn tại hoặc caller không còn quyền xem/thao tác (Anti-IDOR) |
| `409` | `REPAIR_TICKET_INVALID_STATUS` | Thao tác không hợp lệ ở trạng thái hiện tại |
| `409` | `REPAIR_TICKET_ALREADY_CLOSED` | Ticket đã ở trạng thái `CLOSED` trước đó |
| `409` | `REPAIR_TICKET_AUTO_CLOSED` | Ticket vừa được tự động đóng sau 5 ngày không phản hồi khi gọi nghiệm thu (`confirm`/`reject`) |
| `413` | `FILE_TOO_LARGE` | Có ảnh vượt quá 5MB |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | MIME type hoặc Magic Bytes không phải `JPEG`, `PNG`, `WebP` (hoặc MIME không khớp Magic Bytes) |
| `502` | `CLOUDINARY_UPLOAD_FAILED` | Upload Cloudinary thất bại (đã rollback toàn bộ ảnh upload trước đó trong cùng request) |
| `500` | `INTERNAL_ERROR` | Lỗi hệ thống không mong muốn |

---

## 6. Ma trận Notification & AuditLog (Chốt Q7 — Nguyên tử trong `$transaction`)

Toàn bộ 5 mã sự kiện `REPAIR_TICKET_*` đều đã có trong `NOTIFICATION_EVENT_TYPE` và ánh xạ sẵn về `NOTIFICATION_CATEGORY.REPAIR`. Mọi `payload` tuân thủ chuẩn PR #40: `{ content, actionUrl, relatedEntityType: 'REPAIR_TICKET', relatedEntityId: ticket.id, metadata }`.

### 6.1. Notification Matrix (deduplicated theo `recipientId`)
| # | Thao tác | `eventType` | Người nhận (deduplicated) | `title` mẫu (`<= 160` chars) | `actionUrl` |
|---|---|---|---|---|---|
| 1 | `POST /repair-tickets` | `REPAIR_TICKET_CREATED` | Chủ trọ (`property.landlordId`) | `Báo cáo sự cố mới: ${ticket.title}` | `/landlord/repair-tickets/${ticket.id}` |
| 2 | `PATCH /accept` | `REPAIR_TICKET_ACCEPTED` | - Nếu `roomId != null`: **tất cả thành viên đang cư trú `ACTIVE` trong `roomId`** (`contract.tenantId` + mọi `ContractResident` `leftAt IS NULL`).<br>- Nếu `roomId = null`: `createdById` *(chỉ nếu còn cư trú `ACTIVE` tại `propertyId`)*. | `Sự cố đã được tiếp nhận: ${ticket.title}` | `/repair-tickets/${ticket.id}` |
| 3 | `PATCH /complete` | `REPAIR_TICKET_COMPLETED` | - Nếu `roomId != null`: **tất cả thành viên đang cư trú `ACTIVE` trong `roomId`** (`contract.tenantId` + mọi `ContractResident` `leftAt IS NULL`).<br>- Nếu `roomId = null`: `createdById` *(chỉ nếu còn cư trú `ACTIVE` tại `propertyId`)*. | `Sự cố đã sửa xong, vui lòng nghiệm thu trong 5 ngày` | `/repair-tickets/${ticket.id}` |
| 4 | `PATCH /confirm-completion` | `REPAIR_TICKET_CLOSED` | - **Chủ trọ (`property.landlordId`)**<br>- **VÀ các thành viên đang cư trú `ACTIVE` khác trong `roomId`** *(nếu `roomId != null`, **loại trừ `currentUser.id`**)*. | `Sự cố đã được nghiệm thu và đóng: ${ticket.title}` | Landlord: `/landlord/repair-tickets/${ticket.id}`<br>Thành viên phòng khác: `/repair-tickets/${ticket.id}` |
| 5 | `PATCH /reject-completion` | `REPAIR_TICKET_REOPENED` | Chủ trọ (`property.landlordId`) | `Yêu cầu khắc phục lại sự cố: ${ticket.title}` | `/landlord/repair-tickets/${ticket.id}` |
| 6 | Auto-close sau 5 ngày (`autoCloseStaleRepairTickets`) | `REPAIR_TICKET_CLOSED` (`metadata.autoClosed: true`) | - **Chủ trọ (`property.landlordId`)**<br>- Nếu `roomId != null`: **tất cả thành viên đang cư trú `ACTIVE` trong `roomId`**.<br>- Nếu `roomId = null`: `createdById` *(chỉ nếu còn cư trú `ACTIVE` tại `propertyId`)*. | `Sự cố đã tự động đóng sau 5 ngày: ${ticket.title}` | Landlord: `/landlord/repair-tickets/${ticket.id}`<br>Tenant: `/repair-tickets/${ticket.id}` |

### 6.2. AuditLog Matrix (`recordAuditLog(tx, ...)`)
| # | Thao tác | `actorId` | `entityType` | `entityId` | `action` | `oldData` | `newData` |
|---|---|---|---|---|---|---|---|
| 1 | `POST /repair-tickets` | `currentUser.id` | `REPAIR_TICKET` | `ticket.id` | `REPAIR_TICKET_CREATED` | `null` | `{ propertyId, roomId, priority, status: 'OPEN', attachmentCount }` |
| 2 | `PATCH /accept` | `currentUser.id` | `REPAIR_TICKET` | `ticket.id` | `REPAIR_TICKET_ACCEPTED` | `{ status: 'OPEN', resolutionPlan: null, scheduledAt: null }` | `{ status: 'IN_PROGRESS', resolutionPlan, scheduledAt }` |
| 3 | `PATCH /complete` | `currentUser.id` | `REPAIR_TICKET` | `ticket.id` | `REPAIR_TICKET_COMPLETED` | `{ status: 'IN_PROGRESS', completedAt: null, repairCost, costBearer }` | `{ status: 'AWAITING_CONFIRMATION', completedAt, repairCost, costBearer, attachmentCount }` |
| 4 | `PATCH /confirm-completion` | `currentUser.id` | `REPAIR_TICKET` | `ticket.id` | `REPAIR_TICKET_CONFIRMED` | `{ status: 'AWAITING_CONFIRMATION', closedAt: null }` | `{ status: 'CLOSED', closedAt }` |
| 5 | `PATCH /reject-completion` | `currentUser.id` | `REPAIR_TICKET` | `ticket.id` | `REPAIR_TICKET_REOPENED` | `{ status: 'AWAITING_CONFIRMATION', completedAt, repairCost, costBearer }` | `{ status: 'IN_PROGRESS', completedAt: null, repairCost: null, costBearer: null, reason, attachmentCount }` |
| 6 | Auto-close 5 ngày | `null` | `REPAIR_TICKET` | `ticket.id` | `REPAIR_TICKET_AUTO_CLOSED` | `{ status: 'AWAITING_CONFIRMATION', completedAt, closedAt: null }` | `{ status: 'CLOSED', closedAt, autoClosed: true }` |

---

## 7. Cấu trúc Module & Chiến lược Kiểm thử

### 7.1. Files tạo mới / cập nhật
- **Tạo mới trong `src/modules/repair-tickets/`:**
  - `repair-ticket.types.ts` — DTOs, input/query interfaces, repository row types, `AutoCloseBatchResult`.
  - `repair-ticket.validation.ts` — Zod schemas (UUID, create, list query `page` max 10000 / `limit` max 50, accept với `scheduledAt >= now - 5 phút`, complete cặp `repairCost`/`costBearer`, reject-completion).
  - `repair-ticket.upload.ts` — Multer `memoryStorage` middleware (`minFiles`, `maxFiles`, 5MB, Magic Bytes, `allowJsonWithoutFiles`), `buildRepairAttachmentPublicId`, `uploadRepairFilesToCloudinary`, `cleanupUploadedRepairFiles`.
  - `repair-ticket.mapper.ts` — Ánh xạ sang `RepairTicketListItemDTO` & `RepairTicketDetailDTO` (`canEscalateToComplaint`, `autoCloseAt`, `attachmentsByStage`, `latestRejectionReason`, `reopenHistory`, không rò rỉ PII).
  - `repair-ticket.repository.ts` — Pure Prisma queries + `lockTicketRow`, `lockTicketRowSkipLocked`, `lockContractRow`.
  - `repair-ticket.service.ts` — Business rules, `$transaction`, re-check quyền cư trú `ACTIVE` & trạng thái sau `FOR UPDATE`, Cloudinary rollback, `Notification` (Q7), `AuditLog`, `autoCloseStaleRepairTickets`, `autoCloseSingleTicketIfStale`.
  - `repair-ticket.controller.ts` — Express 5 handlers.
  - `repair-ticket.routes.ts` — 7 routes với `requireRole` + `uploadRepairAttachments`.
- **Cập nhật tối giản ngoài module (đúng 3 file):**
  - `src/app.ts` (+1 import, +1 `app.use(repairTicketRouter);`)
  - `src/infrastructure/scheduler/phase3-timers.ts` (+`registerRepairTicketAutoCloseJob()`)
  - `src/server.ts` (+import & gọi `registerRepairTicketAutoCloseJob();`)

### 7.2. Chiến lược Kiểm thử (`tests/repair-tickets/`)
1. `tests/repair-tickets/repair-ticket.validation-mapper.test.ts` — Validation biên (gồm `scheduledAt >= now - 5 phút`, cặp `repairCost`/`costBearer`, `page <= 10000`, `limit <= 50`), upload rollback unit test, DTO mapper (`canEscalateToComplaint` 72h, `autoCloseAt`, `reopenHistory`, zero PII).
2. `tests/repair-tickets/repair-ticket.service.test.ts` — Unit tests cho toàn bộ phân quyền Q1, re-check sau lock `FOR UPDATE`, Cloudinary rollback, Notification Q7, lazy auto-close Q6, cron batch isolation Q8, và static architecture guards `AGENTS.md §2.2`.
3. `tests/repair-tickets/repair-ticket-api.test.ts` — HTTP API tests (`http.createServer(app)`) cho cả 7 endpoints (multipart + JSON, `401`, `403`, `400`, `413`, `415`, `404`, `409`, `200`, `201`) và kiểm tra `registerRepairTicketAutoCloseJob()`.
4. `tests/repair-tickets/repair-ticket-db.integration.test.ts` — PostgreSQL Live DB Integration Tests: mọi thành viên `ACTIVE` trong phòng tạo/xem/nghiệm thu được (Q1); người tạo/thành viên rời phòng (`leftAt != null`) hoặc hết HĐ `ACTIVE` mất cả quyền `GET` lẫn nghiệm thu `404` (Q1); khu vực chung chỉ `createdById` đang `ACTIVE` mới nghiệm thu được; vòng đời đầy đủ (kể cả `reopen` 0 ảnh & có ảnh, reset `repairCost`/`costBearer`); Notification Q7 gửi đúng tất cả thành viên `ACTIVE` trong phòng (loại trừ actor khi `confirm`); luật 72h & tự động đóng 5 ngày (lazy-check + list lazy-check + cron batch + race condition `Promise.all` + Cloudinary rollback khi quá hạn 5 ngày).

---

## 8. Quyết định đã chốt sau `grill-me` (Cổng duyệt #1 — 2026-11-24)

Toàn bộ 9 quyết định nghiệp vụ và kỹ thuật sau đã được Owner phê duyệt chính thức và khóa cứng cho giai đoạn triển khai (`Feature Builder`):

| # | Chủ đề | Quyết định đã chốt (Final) |
|---|---|---|
| Q1 | Phân quyền xem & nghiệm thu (`roomId != null` vs `roomId = null`) & thành viên rời phòng | - **Phòng riêng (`roomId != null`):** Mọi thành viên đang cư trú `ACTIVE` trong hợp đồng `ACTIVE` hiện tại của phòng (Chủ HĐ + tất cả `ContractResident` `leftAt IS NULL`) đều có quyền **xem (`GET /`, `GET /:ticketId`) VÀ nghiệm thu (`confirm`/`reject`)**.<br>- **Khu vực chung (`roomId = null`):** Mọi Tenant có HĐ `ACTIVE` thuộc `propertyId` đều được xem; chỉ `createdById` **VÀ đang còn cư trú `ACTIVE` tại `propertyId`** mới được nghiệm thu.<br>- **Rời phòng / hết HĐ `ACTIVE`:** Cắt **cả quyền xem lẫn quyền nghiệm thu** (`404` ở chi tiết/nghiệm thu, loại khỏi `GET /repair-tickets`), kể cả khi user là `createdById`. Bắt buộc re-check lại điều kiện này **sau khi** `lockTicketRow(tx, ticketId)` (`FOR UPDATE`). |
| Q2 | Lưu `reason` khi `reject-completion` với `0` ảnh | Không tạo `RepairAttachment` ảo (`fileUrl` NOT NULL). Luôn lưu `reason` vào `AuditLog` (`REPAIR_TICKET_REOPENED`) + `Notification.payload` (và `RepairAttachment.reason` khi có 1–3 ảnh). `GET /:ticketId` trả `latestRejectionReason` & `reopenHistory` đọc từ `AuditLog`. |
| Q3 | Ràng buộc `repairCost` / `costBearer` & reset khi `reopen` | Trong `PATCH /complete`: `repairCost` (`>= 0`, kể cả `0`) và `costBearer` (`LANDLORD \| TENANT`) bắt buộc đi cặp (`400 VALIDATION_ERROR` nếu thiếu 1 trong 2). Khi `reject-completion`: đặt `completedAt = null`, `repairCost = null`, `costBearer = null` (lưu giá trị cũ trong `AuditLog.oldData`). |
| Q4 | Giới hạn số lần mở lại & Content-Type `reject-completion` | Không giới hạn số lần `reject-completion`; hỗ trợ cả `multipart/form-data` (0–3 ảnh) lẫn `application/json` (0 ảnh). |
| Q5 | Ràng buộc thời điểm `scheduledAt` (`PATCH /accept`) | Bắt buộc ISO-8601 có timezone hợp lệ và **`scheduledAt >= now - 5 phút`** (`5 * 60 * 1000` ms) để tránh lệch đồng hồ / bấm "sửa ngay". |
| Q6 | Mã HTTP khi `PATCH /confirm-completion` sau mốc 5 ngày | Thực thi lazy auto-close (`CLOSED`, Notification + AuditLog), **commit transaction** bằng `{ outcome: 'AUTO_CLOSED' }`, rồi Service ném **`409 REPAIR_TICKET_AUTO_CLOSED`**. |
| Q7 | Người nhận `Notification` (deduplicated) | - `POST`: Landlord.<br>- `accept` & `complete`: tất cả thành viên `ACTIVE` trong `roomId` (nếu `roomId != null`) hoặc `createdById` còn `ACTIVE` tại `propertyId` (nếu `roomId = null`).<br>- `confirm-completion`: Landlord (`/landlord/repair-tickets/:id`) **VÀ** các thành viên `ACTIVE` khác trong `roomId` loại trừ `currentUser.id` (`/repair-tickets/:id`).<br>- `reject-completion`: Landlord.<br>- Auto-close 5 ngày (`REPAIR_TICKET_CLOSED`, `metadata.autoClosed = true`): Landlord + tất cả thành viên `ACTIVE` trong `roomId` (hoặc `createdById` còn `ACTIVE` tại `propertyId` khi `roomId = null`). |
| Q8 | Cron `phase3-timers.ts` | Chu kỳ `15 phút`, batch `100` ticket/lần, mỗi ticket 1 transaction độc lập với `FOR UPDATE SKIP LOCKED` + `try/catch` cô lập lỗi từng bản ghi. |
| Q9 | Lazy-check list & trường DTO | Chạy lazy auto-close có phạm vi (tối đa 50 ticket) trước khi query `GET /repair-tickets`; trả `autoCloseAt` và `canEscalateToComplaint` trên cả list item lẫn detail DTO. |
