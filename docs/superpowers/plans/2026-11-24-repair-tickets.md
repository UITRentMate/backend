# [BE-P3-09] Repair Tickets, Maintenance Acceptance & 72h / 5-Day Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai hoàn chỉnh phân hệ Báo cáo Sự cố / Sửa chữa, Nghiệm thu & Luật bảo vệ 72 giờ / 5 ngày (`src/modules/repair-tickets/`, 7 endpoints P0) tuân thủ `BP-08`, `BR-10`, `UC-25` và toàn bộ quyết định đã chốt Cổng #1 (Q1–Q9): upload ảnh Cloudinary an toàn có rollback, khóa hàng `FOR UPDATE` + re-check quyền cư trú `ACTIVE` sau khóa, `Notification` & `AuditLog` nguyên tử, và tự động đóng sau 5 ngày qua cả lazy-check lẫn `phase3-timers.ts`.

**Architecture:** Layered Modular Monolith tuân thủ nghiêm ngặt `AGENTS.md §2.2` (chuẩn PR #40/#41): `Routes → Controller → Service → Repository → Prisma Singleton → PostgreSQL`. Tầng `Service` giữ toàn bộ nghiệp vụ, điều phối Cloudinary upload/rollback ngoài transaction, mở `prisma.$transaction`, kiểm tra lại quyền cư trú `ACTIVE` / sở hữu & trạng thái **sau khi** khóa hàng `FOR UPDATE`, ném `ApiError`, tạo `Notification` và `AuditLog`. Tầng `Repository` chỉ giữ các hàm `lock*` và persistence/query Prisma thuần.

**Tech Stack:** Express 5.3.0, TypeScript (CommonJS), Prisma Client 6.19.3, PostgreSQL, Zod 4.6.7, Multer 2.5.0 (`memoryStorage`), Cloudinary (`mediaService` + `validateUploadedImageFile`), Node.js Native Test Runner (`node:test`, `node:assert/strict`).

**Spec:** [docs/superpowers/specs/2026-11-24-repair-tickets-design.md](../specs/2026-11-24-repair-tickets-design.md)
**OpenAPI:** [docs/openapi/repair-tickets.yaml](../../openapi/repair-tickets.yaml)
**Status:** `Approved (Refine Final — 2026-11-24)`

## Global Constraints

- **Zero DB Schema Drift:** Tuyệt đối không chỉnh sửa `prisma/schema.prisma`, không chạy `prisma migrate dev`, không tạo migration mới.
- **Zero Extra Dependencies & CommonJS:** Không chạy `npm install`; giữ nguyên `"module": "CommonJS"` và dùng duy nhất Prisma singleton từ `src/infrastructure/database/prisma.ts`.
- **Phân tách tầng nghiêm ngặt (`AGENTS.md §2.2`):**
  - `repair-ticket.controller.ts`: Chỉ trích `res.locals.currentUser`, validate input bằng Zod, gọi `RepairTicketService`, trả JSON.
  - `repair-ticket.service.ts`: Giữ `$transaction`, kiểm tra lại quyền cư trú `ACTIVE` / sở hữu & trạng thái **SAU khi lock `FOR UPDATE`**, ném `ApiError`, gọi `createNotification`/`createNotificationsBatch` & `recordAuditLog`, điều phối Cloudinary upload/rollback ngoài `$transaction`.
  - `repair-ticket.repository.ts`: Chỉ giữ `lockTicketRow`, `lockTicketRowSkipLocked`, `lockContractRow` và truy vấn/ghi Prisma thuần (nhận `tx: Prisma.TransactionClient` cho thao tác ghi). **KHÔNG** import `ApiError`, `notification.util`, `audit-log.util`, và không mở `$transaction`.
- **Quy tắc Nghiệp vụ Final Gate #1 (Q1–Q9):**
  - **Q1 (Quyền xem & nghiệm thu theo cư trú `ACTIVE` hiện tại):**
    - `roomId != null`: Mọi thành viên đang cư trú `ACTIVE` trong hợp đồng `ACTIVE` hiện tại của `roomId` (`contract.tenantId` + mọi `ContractResident` `leftAt IS NULL`) đều có quyền **xem (`GET /`, `GET /:ticketId`) VÀ nghiệm thu (`confirm-completion`, `reject-completion`)**. Thành viên đã rời phòng (`leftAt != null`) hoặc hết HĐ `ACTIVE` bị cắt **cả quyền xem lẫn nghiệm thu** (`404 REPAIR_TICKET_NOT_FOUND`; loại khỏi `GET /repair-tickets`), kể cả khi là `createdById`.
    - `roomId = null`: Mọi Tenant có HĐ `ACTIVE` tại `propertyId` đều được xem; chỉ `createdById` **VÀ còn cư trú `ACTIVE` tại `propertyId`** mới được nghiệm thu. Rời khu trọ bị cắt cả quyền xem (`404`) lẫn nghiệm thu (`404`).
    - Bắt buộc **re-check quyền cư trú `ACTIVE` SAU khi gọi `lockTicketRow(tx, ticketId)`** trong `confirm-completion` và `reject-completion`.
  - **Q2:** Không tạo `RepairAttachment` ảo khi `reject-completion` có 0 ảnh; luôn lưu `reason` vào `AuditLog` (`REPAIR_TICKET_REOPENED`) + `Notification.payload` (và `RepairAttachment.reason` khi có 1–3 ảnh), trả `latestRejectionReason` & `reopenHistory` trên `GET /:ticketId`.
  - **Q3:** `repairCost` (`>= 0`, kể cả `0`) và `costBearer` (`LANDLORD | TENANT`) bắt buộc đi cặp (`400 VALIDATION_ERROR` nếu thiếu 1 trong 2); khi `reject-completion` reset `completedAt = null`, `repairCost = null`, `costBearer = null` (lưu giá trị cũ trong `AuditLog.oldData`).
  - **Q4:** Không giới hạn số lần `reject-completion`; hỗ trợ cả `multipart/form-data` (0–3 ảnh) lẫn `application/json` (0 ảnh).
  - **Q5:** `scheduledAt` ở `PATCH /accept` phải là ISO-8601 có timezone hợp lệ và **`scheduledAt >= now - 5 phút`** (`5 * 60 * 1000` ms).
  - **Q6:** `confirm-completion` & `reject-completion` sau mốc 5 ngày phải commit auto-close (`{ outcome: 'AUTO_CLOSED' }`) trước khi Service dọn ảnh (nếu có) và ném **`409 REPAIR_TICKET_AUTO_CLOSED`**.
  - **Q7 (Notification deduplicated):** `POST` → Landlord; `accept`/`complete` → toàn bộ thành viên `ACTIVE` trong `roomId` (hoặc `createdById` còn `ACTIVE` tại `propertyId` nếu `roomId = null`); `confirm-completion` → Landlord (`/landlord/repair-tickets/:id`) **VÀ** các thành viên `ACTIVE` khác trong `roomId` loại trừ `currentUser.id` (`/repair-tickets/:id`); `reject-completion` → Landlord; Auto-close 5 ngày (`REPAIR_TICKET_CLOSED`, `metadata.autoClosed = true`) → Landlord + toàn bộ thành viên `ACTIVE` trong `roomId` (hoặc `createdById` còn `ACTIVE` tại `propertyId` nếu `roomId = null`).
  - **Q8:** Cron `phase3-timers.ts` chạy mỗi `15 phút`, batch `100` ticket/lần, `FOR UPDATE SKIP LOCKED` + `try/catch` độc lập từng bản ghi.
  - **Q9:** `GET /repair-tickets` chạy lazy auto-close theo phạm vi (tối đa 50 ticket) trước khi query; trả `autoCloseAt` và `canEscalateToComplaint` trên cả list item lẫn detail DTO.
- **Kiểm soát Xung đột với PR #42 & PR #43:**
  - **KHÔNG sửa** `src/common/constants/phase3-status.ts`, `src/common/utils/cloudinary.util.ts`, `src/common/utils/notification.util.ts`, `src/common/utils/audit-log.util.ts`, `src/modules/media/*`.
  - **Chỉ chạm đúng 3 file ngoài module:** `src/app.ts` (+1 import, +1 `app.use`), `src/infrastructure/scheduler/phase3-timers.ts` (+`registerRepairTicketAutoCloseJob` ở cuối file), `src/server.ts` (+import & gọi `registerRepairTicketAutoCloseJob()`).
- **Anti-IDOR & Privacy-by-Default:** Mọi `User` select chỉ dùng `{ id: true, fullName: true, avatarUrl: true }`; giới hạn cứng phân trang `page <= 10_000`, `limit <= 50` (alias `pageSize`).

## Review Focus

1. **Quyền xem & nghiệm thu Q1 khi cư dân rời phòng / hết hợp đồng `ACTIVE` (kể cả `createdById`):** Sau khi `leftAt` được đặt hoặc hợp đồng hết `ACTIVE`, chính người tạo phiếu phải lập tức nhận `404` ở `GET /:ticketId`, `confirm-completion`, `reject-completion` và không còn thấy ticket đó trong `GET /repair-tickets`; đồng thời `CO_RESIDENT` đang `ACTIVE` khác trong phòng phải nghiệm thu thành công (kiểm chứng ở Task 3 & Task 5).
2. **Rò rỉ ảnh rác Cloudinary khi upload phần tử giữa lỗi, DB rollback, hoặc race condition với 5 ngày auto-close:** Nếu ảnh #3/5 lỗi hoặc ticket vừa bị đóng/tự đóng khi ảnh đang tải lên, toàn bộ ảnh đã lên Cloudinary phải được xóa sạch qua `mediaService.deleteResource` mà không che mất lỗi gốc (kiểm chứng ở Task 1, Task 3, Task 5).
3. **Bẫy Transaction Rollback khi Lazy Auto-Close 5 ngày (`confirm-completion` & `reject-completion` — Q6) và Race Condition với Cron:** Không được `throw` trong `$transaction` sau khi cập nhật `CLOSED`; chạy song song `Promise.all([autoCloseStaleRepairTickets(), confirm/reject])` chỉ commit đóng đúng 1 lần và không tạo trùng Notification/AuditLog (kiểm chứng ở Task 3 & Task 5).
4. **Notification Q7 khi `confirm-completion` có nhiều thành viên `ACTIVE` trong phòng & khi `createdById` đã rời khu trọ (khu vực chung):** `confirm-completion` phải gửi cho Landlord (`actionUrl: /landlord/repair-tickets/:id`) VÀ các thành viên `ACTIVE` còn lại trong phòng (`actionUrl: /repair-tickets/:id`), KHÔNG gửi lại cho chính người bấm `confirm`; với sự cố khu vực chung mà `createdById` đã rời khu trọ, `accept`/`complete`/auto-close không gửi thông báo cho cựu cư dân (kiểm chứng ở Task 3 & Task 5).
5. **Nghiệm thu chưa đạt 0 ảnh (Q2), Reset chi phí (Q3) & Cửa sổ `scheduledAt >= now - 5 phút` (Q5):** `reject-completion` 0 ảnh (JSON hoặc multipart) không tạo dòng `RepairAttachment`, xóa sạch `completedAt`/`repairCost`/`costBearer`, và `GET /:ticketId` trả đúng `latestRejectionReason` + `reopenHistory`; `scheduledAt` lùi 4 phút được chấp nhận nhưng lùi 6 phút bị chặn `400 VALIDATION_ERROR` (kiểm chứng ở Task 1, Task 4, Task 5).

---

## File Structure

- Create: `src/modules/repair-tickets/repair-ticket.types.ts`
- Create: `src/modules/repair-tickets/repair-ticket.validation.ts`
- Create: `src/modules/repair-tickets/repair-ticket.upload.ts`
- Create: `src/modules/repair-tickets/repair-ticket.mapper.ts`
- Create: `src/modules/repair-tickets/repair-ticket.repository.ts`
- Create: `src/modules/repair-tickets/repair-ticket.service.ts`
- Create: `src/modules/repair-tickets/repair-ticket.controller.ts`
- Create: `src/modules/repair-tickets/repair-ticket.routes.ts`
- Modify: `src/app.ts` (+1 import, +1 `app.use(repairTicketRouter);`)
- Modify: `src/infrastructure/scheduler/phase3-timers.ts` (+`registerRepairTicketAutoCloseJob()`)
- Modify: `src/server.ts` (+import & call `registerRepairTicketAutoCloseJob()`)
- Test: `tests/repair-tickets/repair-ticket.validation-mapper.test.ts`
- Test: `tests/repair-tickets/repair-ticket.service.test.ts`
- Test: `tests/repair-tickets/repair-ticket-api.test.ts`
- Test: `tests/repair-tickets/repair-ticket-db.integration.test.ts`

---

### Task 1: Types, Zod Validation, Upload Middleware & DTO Mapper (`src/modules/repair-tickets/`)

**Files:**
- Create: `src/modules/repair-tickets/repair-ticket.types.ts`
- Create: `src/modules/repair-tickets/repair-ticket.validation.ts`
- Create: `src/modules/repair-tickets/repair-ticket.upload.ts`
- Create: `src/modules/repair-tickets/repair-ticket.mapper.ts`
- Test: `tests/repair-tickets/repair-ticket.validation-mapper.test.ts`

**Interfaces:**
- Produces in `src/modules/repair-tickets/repair-ticket.types.ts`:
  - `CreateRepairTicketInput`, `RepairTicketListQuery`, `AcceptRepairTicketInput`, `CompleteRepairTicketInput`, `RejectRepairCompletionInput`
  - `UserSummaryDTO`, `RepairPropertySummaryDTO`, `RepairRoomSummaryDTO`, `RepairAttachmentDTO`, `RepairAttachmentsByStageDTO`, `RepairReopenHistoryItemDTO`, `RepairTicketListItemDTO`, `RepairTicketDetailDTO`, `PaginatedRepairTicketsDTO`
  - `UploadedRepairAttachment`, `AutoCloseBatchResult`
  - Raw Prisma row interfaces (`RepairTicketListRow`, `RepairTicketDetailRow`, `RepairTicketMutationRow`, `ReopenAuditLogRow`, `ActiveResidencyMatch`).
- Produces in `src/modules/repair-tickets/repair-ticket.validation.ts`:
  - `MAX_REPAIR_TICKET_PAGE = 10_000`, `MAX_REPAIR_TICKET_LIMIT = 50`, `MAX_REPAIR_COST = 999_999_999_999.99`, `SCHEDULED_AT_PAST_GRACE_MS = 5 * 60 * 1000`
  - `validateTicketId(rawId: unknown): string`
  - `validateCreateRepairTicketBody(rawBody: unknown): CreateRepairTicketInput`
  - `validateRepairTicketListQuery(rawQuery: unknown): RepairTicketListQuery`
  - `validateAcceptRepairTicketBody(rawBody: unknown, now?: Date): AcceptRepairTicketInput`
  - `validateCompleteRepairTicketBody(rawBody: unknown): CompleteRepairTicketInput`
  - `validateRejectRepairCompletionBody(rawBody: unknown): RejectRepairCompletionInput`
- Produces in `src/modules/repair-tickets/repair-ticket.upload.ts`:
  - `uploadRepairAttachments(options: { minFiles: number; maxFiles: number; allowJsonWithoutFiles?: boolean }): RequestHandler`
  - `buildRepairAttachmentPublicId(propertyId: string, ticketId: string, stage: RepairAttachmentStage, attachmentId: string): string`
  - `uploadRepairFilesToCloudinary(files: readonly Express.Multer.File[], params: { propertyId: string; ticketId: string; stage: RepairAttachmentStage }): Promise<UploadedRepairAttachment[]>`
  - `cleanupUploadedRepairFiles(publicIds: readonly string[]): Promise<void>`
- Produces in `src/modules/repair-tickets/repair-ticket.mapper.ts`:
  - `computeCanEscalateToComplaint(status: string, createdAt: Date, now?: Date): boolean`
  - `computeAutoCloseAt(status: string, completedAt: Date | null): string | null`
  - `mapRepairTicketListItem(row: RepairTicketListRow, now?: Date): RepairTicketListItemDTO`
  - `mapRepairTicketDetail(row: RepairTicketDetailRow, reopenLogs: readonly ReopenAuditLogRow[], now?: Date): RepairTicketDetailDTO`

- [ ] **Step 1: Write failing tests in `tests/repair-tickets/repair-ticket.validation-mapper.test.ts`**

Viết unit tests phủ toàn bộ biên:
- `validateTicketId`: từ chối chuỗi không phải UUID (`400 VALIDATION_ERROR`).
- `validateCreateRepairTicketBody`:
  - Chấp nhận chỉ `roomId`, chỉ `propertyId`, hoặc cả 2; mặc định `priority = 'MEDIUM'`; chuẩn hóa `""` → `undefined`.
  - Từ chối thiếu cả `roomId` & `propertyId`, `title < 5` hoặc `> 200`, `description < 10` hoặc `> 2000`, `priority` sai enum.
- `validateRepairTicketListQuery`:
  - Mặc định `{ page: 1, limit: 20 }`; hỗ trợ alias `pageSize` (ưu tiên `limit`); từ chối `page = 0`, `page = 10001`, `limit = 51`, UUID sai ở `propertyId`/`roomId`, enum sai ở `status`/`priority`.
- `validateAcceptRepairTicketBody` (Q5):
  - Chấp nhận `resolutionPlan` (5..1000) + `scheduledAt` ở tương lai VÀ `scheduledAt = now - 4 phút` (trong cửa sổ 5 phút).
  - Từ chối `scheduledAt = now - 6 phút` (`400 VALIDATION_ERROR`), chuỗi thiếu timezone, hoặc trường thừa (`.strict()`).
- `validateCompleteRepairTicketBody` (Q3):
  - Chấp nhận bỏ trống cả `repairCost` & `costBearer`; chấp nhận `"350000"` + `"LANDLORD"` và `"0"` + `"TENANT"`.
  - Từ chối có `repairCost` (kể cả `"0"`) mà thiếu `costBearer`, có `costBearer` mà thiếu `repairCost`, `repairCost < 0`, `repairCost > 999999999999.99`, hơn 2 chữ số thập phân, `"NaN"`.
- `validateRejectRepairCompletionBody`:
  - Chấp nhận `reason` 10..1000 ký tự; từ chối `< 10` hoặc `> 1000`.
- `uploadRepairFilesToCloudinary`:
  - Stub `mediaService.uploadStream` thành công file #1 & #2, thất bại file #3 → assert `mediaService.deleteResource` gọi đúng 2 lần cho publicId #1 & #2, và ném `ApiError(502, 'CLOUDINARY_UPLOAD_FAILED', ...)`.
- `computeCanEscalateToComplaint`, `computeAutoCloseAt`, `mapRepairTicketListItem`, `mapRepairTicketDetail`:
  - `OPEN` sau 71h59m59s → `false`; `OPEN` đúng 72h00m00s → `true`; `IN_PROGRESS` sau 100h → `false`.
  - `AWAITING_CONFIRMATION` trả `autoCloseAt = completedAt + 5 ngày` trên cả list item và detail DTO; trạng thái khác trả `null`.
  - Gom nhóm `attachmentsByStage` đủ 3 khóa `INITIAL`, `COMPLETION`, `REOPEN_EVIDENCE`; xuất `latestRejectionReason` & `reopenHistory`; JSON đầu ra không chứa `passwordHash`/`email`/`phone`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/repair-tickets/repair-ticket.validation-mapper.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `repair-ticket.types.ts`, `repair-ticket.validation.ts`, `repair-ticket.upload.ts`, and `repair-ticket.mapper.ts`**

- Tái sử dụng `validateUploadedImageFile` từ `src/common/utils/cloudinary.util.ts` và `mediaService` từ `src/modules/media/media.service.ts` (không sửa 2 file đó).
- Tái sử dụng toàn bộ hằng số `REPAIR_TICKET_*` và `PHASE3_TIME_LIMITS_MS` từ `src/common/constants/phase3-status.ts`.
- `uploadRepairAttachments` hỗ trợ `allowJsonWithoutFiles: true` khi `req.is('application/json')` cho `PATCH /reject-completion`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/repair-tickets/repair-ticket.validation-mapper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/repair-tickets/repair-ticket.types.ts src/modules/repair-tickets/repair-ticket.validation.ts src/modules/repair-tickets/repair-ticket.upload.ts src/modules/repair-tickets/repair-ticket.mapper.ts tests/repair-tickets/repair-ticket.validation-mapper.test.ts
git commit -m "feat(repair-tickets): add types, Zod validation, upload helper, and DTO mappers"
```

---

### Task 2: Triển khai Pure Repository Layer (`repair-ticket.repository.ts`)

**Files:**
- Create: `src/modules/repair-tickets/repair-ticket.repository.ts`

**Interfaces:**
- Consumes:
  - `prisma` từ `src/infrastructure/database/prisma.ts`
  - `CONTRACT_STATUS`, `REPAIR_TICKET_STATUS` từ `src/common/constants/phase3-status.ts`
  - Types từ `src/modules/repair-tickets/repair-ticket.types.ts`
- Produces (`RepairTicketRepository` — **KHÔNG** `ApiError`, **KHÔNG** `Notification`/`AuditLog`, **KHÔNG** `$transaction`):
  - **Row locks (raw parameterized SQL):**
    - `lockContractRow(tx: Prisma.TransactionClient, contractId: string): Promise<boolean>`
    - `lockTicketRow(tx: Prisma.TransactionClient, ticketId: string): Promise<boolean>`
    - `lockTicketRowSkipLocked(tx: Prisma.TransactionClient, ticketId: string): Promise<boolean>`
  - **Residency & Access queries (phục vụ Q1 & Q7):**
    - `findActiveResidencyForRoom(db: PrismaDbClient, roomId: string, userId: string): Promise<ActiveResidencyMatch | null>`
    - `findActiveResidencyForProperty(db: PrismaDbClient, propertyId: string, userId: string): Promise<ActiveResidencyMatch | null>`
    - `findTenantActiveScope(userId: string): Promise<{ activeRoomIds: string[]; activePropertyIds: string[] }>`
    - `findActiveResidentUserIdsForRoom(db: PrismaDbClient, roomId: string): Promise<string[]>` *(trả deduplicated `[contract.tenantId, ...activeCoResidentIds]` của hợp đồng `ACTIVE` thuộc `roomId`)*
  - **Ticket read queries:**
    - `findTicketDetailById(db: PrismaDbClient, ticketId: string): Promise<RepairTicketDetailRow | null>`
    - `findTicketForMutation(tx: Prisma.TransactionClient, ticketId: string): Promise<RepairTicketMutationRow | null>`
    - `findTicketsPaginated(where: Prisma.RepairTicketWhereInput, page: number, limit: number): Promise<{ items: RepairTicketListRow[]; total: number }>`
    - `findReopenAuditLogs(db: PrismaDbClient, ticketId: string): Promise<ReopenAuditLogRow[]>`
    - `findStaleAwaitingConfirmationTicketIds(cutoff: Date, limit: number, extraWhere?: Prisma.RepairTicketWhereInput): Promise<string[]>`
  - **Ticket & Attachment write operations (bắt buộc nhận `tx: Prisma.TransactionClient`):**
    - `createTicketWithAttachments(tx: Prisma.TransactionClient, data: CreateTicketRepoInput): Promise<RepairTicketDetailRow>`
    - `updateTicket(tx: Prisma.TransactionClient, ticketId: string, data: Prisma.RepairTicketUpdateInput): Promise<void>`
    - `createAttachments(tx: Prisma.TransactionClient, rows: Prisma.RepairAttachmentCreateManyInput[]): Promise<void>`

- [ ] **Step 1: Implement `src/modules/repair-tickets/repair-ticket.repository.ts`**

- Mọi `User` select đều dùng hằng `USER_SUMMARY_SELECT = { id: true, fullName: true, avatarUrl: true } as const`.
- `lockContractRow`, `lockTicketRow`, `lockTicketRowSkipLocked` dùng `tx.$queryRaw<Array<{ id: string }>>` parameterized với `::uuid`.
- `findActiveResidentUserIdsForRoom` lấy hợp đồng `status = 'ACTIVE'` của `roomId` kèm `contractResidents: { where: { leftAt: null }, select: { userId: true } }` và trả mảng deduplicated.
- `findTicketsPaginated` chạy song song `findMany` (`orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]`) và `count`.
- `findTicketDetailById` sắp xếp `attachments` theo `[{ id: 'asc' }]` (vì `repair_attachments` không có `createdAt`).

- [ ] **Step 2: Run typecheck to verify Repository compiles cleanly**

Run: `npm run typecheck`
Expected: 0 TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/repair-tickets/repair-ticket.repository.ts
git commit -m "feat(repair-tickets): implement pure repository layer with row locking"
```

---

### Task 3: Triển khai Service Layer, Luật 72h / 5 ngày & Unit Tests (`repair-ticket.service.ts`)

**Files:**
- Create: `src/modules/repair-tickets/repair-ticket.service.ts`
- Test: `tests/repair-tickets/repair-ticket.service.test.ts`

**Interfaces:**
- Consumes:
  - `prisma` (`src/infrastructure/database/prisma.ts`) — mở `$transaction` đúng chuẩn `AGENTS.md §2.2`
  - `RepairTicketRepository` (Task 2)
  - `uploadRepairFilesToCloudinary`, `cleanupUploadedRepairFiles` (Task 1)
  - `mapRepairTicketListItem`, `mapRepairTicketDetail` (Task 1)
  - `createNotification`, `createNotificationsBatch` (`src/common/utils/notification.util.ts`)
  - `recordAuditLog` (`src/common/utils/audit-log.util.ts`)
  - `CONTRACT_STATUS`, `REPAIR_TICKET_STATUS`, `REPAIR_ATTACHMENT_STAGE`, `NOTIFICATION_EVENT_TYPE`, `PHASE3_TIME_LIMITS_MS`
- Produces (`RepairTicketService` + exported `autoCloseStaleRepairTickets`):
  - `createRepairTicket(input: CreateRepairTicketInput, files: readonly Express.Multer.File[], currentUser: CurrentUser): Promise<RepairTicketDetailDTO>`
  - `listRepairTickets(query: RepairTicketListQuery, currentUser: CurrentUser): Promise<PaginatedRepairTicketsDTO>`
  - `getRepairTicketDetail(ticketId: string, currentUser: CurrentUser): Promise<RepairTicketDetailDTO>`
  - `acceptRepairTicket(ticketId: string, input: AcceptRepairTicketInput, currentUser: CurrentUser): Promise<RepairTicketDetailDTO>`
  - `completeRepairTicket(ticketId: string, input: CompleteRepairTicketInput, files: readonly Express.Multer.File[], currentUser: CurrentUser): Promise<RepairTicketDetailDTO>`
  - `confirmCompletion(ticketId: string, currentUser: CurrentUser): Promise<RepairTicketDetailDTO>`
  - `rejectCompletion(ticketId: string, input: RejectRepairCompletionInput, files: readonly Express.Multer.File[], currentUser: CurrentUser): Promise<RepairTicketDetailDTO>`
  - `autoCloseSingleTicketIfStale(ticketId: string, now?: Date): Promise<boolean>`
  - `autoCloseStaleRepairTickets(options?: { now?: Date; batchSize?: number; extraWhere?: Prisma.RepairTicketWhereInput }): Promise<AutoCloseBatchResult>`

- [ ] **Step 1: Write failing unit tests in `tests/repair-tickets/repair-ticket.service.test.ts`**

Viết unit tests (stub `RepairTicketRepository`, `prisma.$transaction`, `mediaService`, khôi phục trong `finally`):
- **Static architecture guards (`AGENTS.md §2.2`):**
  - Đọc `src/modules/repair-tickets/repair-ticket.repository.ts` và assert KHÔNG import `ApiError`, `notification.util`, `audit-log.util`, KHÔNG gọi `$transaction`.
- **`createRepairTicket`:**
  - Pre-check không có hợp đồng `ACTIVE` → ném `404 ROOM_NOT_FOUND` / `404 PROPERTY_NOT_FOUND` và **không gọi Cloudinary**.
  - Truyền `roomId` kèm `propertyId` lệch với `room.propertyId` → `404 ROOM_NOT_FOUND`.
  - Mất tư cách cư trú sau khi lock `Contract FOR UPDATE` hoặc DB transaction lỗi → gọi `cleanupUploadedRepairFiles` xóa đủ toàn bộ ảnh vừa upload rồi ném tiếp lỗi gốc.
- **`listRepairTickets` & `getRepairTicketDetail` (Q1, Q9):**
  - Tenant không còn hợp đồng `ACTIVE` nào → `listRepairTickets` trả `{ items: [], total: 0, page, limit, totalPages: 0 }` (không trả ticket cũ dù là `createdById`).
  - `getRepairTicketDetail`: cựu cư dân (kể cả `createdById`) của sự cố phòng riêng hoặc khu vực chung → `404 REPAIR_TICKET_NOT_FOUND`.
  - `listRepairTickets` gọi lazy auto-close scoped tối đa `batchSize: 50` trước khi `findTicketsPaginated`.
- **`acceptRepairTicket` & `completeRepairTicket` (Q7):**
  - Chủ trọ khác → `404 REPAIR_TICKET_NOT_FOUND` (không upload Cloudinary ở `complete`).
  - Sai trạng thái → `409 REPAIR_TICKET_INVALID_STATUS` / `409 REPAIR_TICKET_ALREADY_CLOSED`.
  - `roomId != null` → gửi Notification cho **tất cả thành viên `ACTIVE` trong phòng**; `roomId = null` → chỉ gửi cho `createdById` nếu còn cư trú `ACTIVE` tại `propertyId`.
  - `complete` gặp lỗi DB sau khi upload ảnh → rollback xóa toàn bộ ảnh `COMPLETION` trên Cloudinary.
- **`confirmCompletion` & `rejectCompletion` (Q1, Q2, Q3, Q6, Q7):**
  - `roomId != null`: `CO_RESIDENT` đang `ACTIVE` (không phải `createdById`) được phép nghiệm thu thành công; cựu cư dân (`createdById` đã rời phòng) bị chặn `404 REPAIR_TICKET_NOT_FOUND` **sau khi** `lockTicketRow`.
  - `roomId = null`: chỉ `createdById` đang `ACTIVE` tại `propertyId` được nghiệm thu; Tenant khác cùng khu trọ hoặc `createdById` đã rời khu trọ nhận `404 REPAIR_TICKET_NOT_FOUND`.
  - `confirmCompletion` với `roomId != null` (3 thành viên `ACTIVE` trong phòng) → tạo Notification `REPAIR_TICKET_CLOSED` cho Landlord (`/landlord/repair-tickets/:id`) + 2 thành viên còn lại (`/repair-tickets/:id`), **không gửi lại cho `currentUser.id`**.
  - `rejectCompletion` với 0 ảnh → chuyển `IN_PROGRESS`, đặt `completedAt = null`, `repairCost = null`, `costBearer = null`, không gọi `createAttachments`, ghi `AuditLog` (`REPAIR_TICKET_REOPENED` kèm `reason` + `oldData` chi phí cũ), gửi `REPAIR_TICKET_REOPENED` cho Landlord.
  - Quá hạn 5 ngày → transaction commit auto-close và trả `{ outcome: 'AUTO_CLOSED' }`, Service dọn ảnh `REOPEN_EVIDENCE` vừa upload (nếu có) và ném **`409 REPAIR_TICKET_AUTO_CLOSED`**.
- **`autoCloseStaleRepairTickets` (Q8):**
  - Batch 3 ticket: ticket #1 đóng thành công, ticket #2 bị `lockTicketRowSkipLocked` trả `false` (skip), ticket #3 ném lỗi → trả `{ scanned: 3, closedCount: 1, skippedCount: 1, failedCount: 1 }` (không dừng batch).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/repair-tickets/repair-ticket.service.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/modules/repair-tickets/repair-ticket.service.ts`**

Triển khai đầy đủ 7 nghiệp vụ endpoint + `autoCloseSingleTicketIfStale` + `autoCloseStaleRepairTickets` khớp 100% Spec Mục 3, 4, 6 và Quyết định Q1–Q9 (bắt buộc re-check quyền cư trú `ACTIVE` sau `lockTicketRow` trong `confirmCompletion` & `rejectCompletion`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/repair-tickets/repair-ticket.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/repair-tickets/repair-ticket.service.ts tests/repair-tickets/repair-ticket.service.test.ts
git commit -m "feat(repair-tickets): implement service layer, Q1-Q9 rules, Cloudinary rollback, and unit tests"
```

---

### Task 4: Controller, Routes, App Mount, Scheduler Registration & HTTP API Tests

**Files:**
- Create: `src/modules/repair-tickets/repair-ticket.controller.ts`
- Create: `src/modules/repair-tickets/repair-ticket.routes.ts`
- Modify: `src/app.ts`
- Modify: `src/infrastructure/scheduler/phase3-timers.ts`
- Modify: `src/server.ts`
- Test: `tests/repair-tickets/repair-ticket-api.test.ts`

**Interfaces:**
- Consumes: `RepairTicketService` (Task 3), Validation & Upload middleware (Task 1), `requireRole` (`src/common/middleware/require-role.ts`).
- Produces:
  - `repairTicketRouter` với đúng 7 routes:
    - `POST /api/v1/repair-tickets` (`requireRole('TENANT')`, `uploadRepairAttachments({ minFiles: 1, maxFiles: 5 })`)
    - `GET /api/v1/repair-tickets` (`requireRole('TENANT', 'LANDLORD')`)
    - `GET /api/v1/repair-tickets/:ticketId` (`requireRole('TENANT', 'LANDLORD')`)
    - `PATCH /api/v1/repair-tickets/:ticketId/accept` (`requireRole('LANDLORD')`)
    - `PATCH /api/v1/repair-tickets/:ticketId/complete` (`requireRole('LANDLORD')`, `uploadRepairAttachments({ minFiles: 1, maxFiles: 5 })`)
    - `PATCH /api/v1/repair-tickets/:ticketId/confirm-completion` (`requireRole('TENANT')`)
    - `PATCH /api/v1/repair-tickets/:ticketId/reject-completion` (`requireRole('TENANT')`, `uploadRepairAttachments({ minFiles: 0, maxFiles: 3, allowJsonWithoutFiles: true })`)
  - `registerRepairTicketAutoCloseJob()` đặt ở cuối `src/infrastructure/scheduler/phase3-timers.ts` (đăng ký job `'repair-ticket-auto-close'`, `intervalMs: 15 * 60 * 1000`).
  - Mount `app.use(repairTicketRouter);` trong `src/app.ts` và gọi `registerRepairTicketAutoCloseJob();` trong `src/server.ts`.

- [ ] **Step 1: Write failing HTTP API tests in `tests/repair-tickets/repair-ticket-api.test.ts`**

Khởi chạy `http.createServer(app)` với `signAccessToken`, stub `prisma.user.findUnique` + `RepairTicketService`:
- Thiếu token → `401 UNAUTHORIZED` trên cả 7 endpoints.
- Tài khoản `LOCKED` → `403 ACCOUNT_LOCKED`.
- RBAC:
  - `LANDLORD` gọi `POST /`, `PATCH /confirm-completion`, `PATCH /reject-completion` → `403 FORBIDDEN`.
  - `TENANT` gọi `PATCH /accept`, `PATCH /complete` → `403 FORBIDDEN`.
  - `ADMIN` gọi bất kỳ endpoint nào → `403 FORBIDDEN`.
- Multipart upload validation qua HTTP thật (`FormData` native Node 24):
  - `POST /` và `PATCH /complete` không gửi ảnh → `400 ATTACHMENTS_REQUIRED`.
  - `POST /` gửi 6 ảnh hoặc `PATCH /reject-completion` gửi 4 ảnh → `400 ATTACHMENT_LIMIT_EXCEEDED`.
  - Gửi file giả mạo MIME (`image/jpeg` nội dung text) → `415 UNSUPPORTED_MEDIA_TYPE`.
  - Gửi file > 5MB → `413 FILE_TOO_LARGE`.
  - `PATCH /reject-completion` gửi `application/json` (`{ reason }`) và `multipart/form-data` (0 ảnh và 2 ảnh PNG hợp lệ) đều trả `200 OK`.
- Path param `ticketId` sai UUID & query `page=10001` / `limit=51` → `400 VALIDATION_ERROR`.
- Static check `repair-ticket.controller.ts` không import `prisma`; kiểm tra `registerRepairTicketAutoCloseJob()` đăng ký job `'repair-ticket-auto-close'` (`intervalMs === 15 * 60 * 1000`) vào `listRegisteredPhase3Jobs()` (dọn lại sau test).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/repair-tickets/repair-ticket-api.test.ts`
Expected: FAIL (module not found / 404).

- [ ] **Step 3: Implement Controller, Routes, mount in `src/app.ts`, register timer in `phase3-timers.ts` & `src/server.ts`**

- Giữ diff cực kỳ tối giản trên `src/app.ts` (2 dòng), `src/infrastructure/scheduler/phase3-timers.ts` (cuối file), `src/server.ts` (1 dòng gọi).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/repair-tickets/repair-ticket-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/repair-tickets/repair-ticket.controller.ts src/modules/repair-tickets/repair-ticket.routes.ts src/app.ts src/infrastructure/scheduler/phase3-timers.ts src/server.ts tests/repair-tickets/repair-ticket-api.test.ts
git commit -m "feat(repair-tickets): add controller, routes, app mount, timer registration, and HTTP tests"
```

---

### Task 5: PostgreSQL Live DB Integration Tests (Full Lifecycle, Q1–Q9, 72h/5d Rules, Concurrency & Anti-IDOR)

**Files:**
- Create: `tests/repair-tickets/repair-ticket-db.integration.test.ts`

**Interfaces:**
- Consumes: `app` (`src/app.ts`), `prisma` (`src/infrastructure/database/prisma.ts`), `signAccessToken`, `mediaService` (stub upload/delete), `autoCloseStaleRepairTickets`.

- [ ] **Step 1: Write PostgreSQL Live DB Integration Tests in `tests/repair-tickets/repair-ticket-db.integration.test.ts`**

Tuân thủ pattern `try ... finally` dọn sạch toàn bộ dữ liệu test (skip có thông báo rõ nếu PostgreSQL không khả dụng), stub `mediaService.uploadStream` & `mediaService.deleteResource`:

1. **Tạo sự cố (`BR-10`) — Chủ HĐ & Người ở cùng (`ACTIVE`), Phòng riêng & Khu vực chung (`roomId = null`), Anti-IDOR:**
   - Chủ HĐ (`ACTIVE`) tạo ticket phòng riêng kèm 2 ảnh PNG hợp lệ → `201`, DB có `RepairTicket` (`status = 'OPEN'`), 2 `RepairAttachment` (`stage = 'INITIAL'`), 1 `Notification` (`REPAIR_TICKET_CREATED`) cho Landlord, 1 `AuditLog` (`REPAIR_TICKET_CREATED`).
   - Người ở cùng (`ContractResident` `leftAt IS NULL`) tạo ticket phòng riêng & ticket khu vực chung (`roomId = null, propertyId`) → cả 2 đều `201`.
   - Tenant thuê phòng khác tạo ticket cho phòng người khác → `404 ROOM_NOT_FOUND` (0 ảnh gọi Cloudinary).
   - Tenant có hợp đồng `TERMINATED` hoặc Former Co-Resident (`leftAt != null`) tạo ticket → `404`.
2. **Quyền xem & nghiệm thu Q1 (Phòng riêng mọi thành viên `ACTIVE`, Rời phòng mất cả `GET` lẫn nghiệm thu `404`, Khu vực chung chỉ `createdById` đang `ACTIVE`):**
   - Tạo phòng có Chủ HĐ A + Người ở cùng B (`ACTIVE`) + Người ở cùng C (`ACTIVE`); Chủ HĐ A tạo ticket phòng → Landlord `accept` & `complete`:
     - Kiểm tra DB có đủ 3 `Notification` (`REPAIR_TICKET_ACCEPTED` và `REPAIR_TICKET_COMPLETED`) gửi cho cả A, B, C (Q7).
     - **Người ở cùng B** (không phải `createdById`) gọi `PATCH /confirm-completion` → **`200 OK`** (`CLOSED`), và kiểm tra DB có đúng 3 `Notification` (`REPAIR_TICKET_CLOSED`): 1 cho Landlord (`/landlord/repair-tickets/:id`), 1 cho A (`/repair-tickets/:id`), 1 cho C (`/repair-tickets/:id`), **KHÔNG gửi cho B** (Q7)!
   - **Test cắt quyền khi rời phòng (Q1):** Người ở cùng B tạo 1 ticket phòng riêng + 1 ticket khu vực chung → đặt `ContractResident.leftAt = now()` cho B (B không còn HĐ `ACTIVE` nào tại khu trọ):
     - B gọi `GET /api/v1/repair-tickets` → **KHÔNG** còn thấy cả 2 ticket do chính B tạo (`items` rỗng).
     - B gọi `GET /api/v1/repair-tickets/:id` cho cả 2 ticket → **`404 REPAIR_TICKET_NOT_FOUND`**.
     - Sau khi Landlord `accept` & `complete`, B gọi `PATCH /confirm-completion` và `PATCH /reject-completion` → **`404 REPAIR_TICKET_NOT_FOUND`**.
     - Trong khi đó Chủ HĐ A (đang `ACTIVE` ở phòng) vẫn xem và nghiệm thu được ticket phòng mà B tạo trước đó!
   - **Test khu vực chung (`roomId = null`):** Chủ HĐ phòng khác trong cùng khu trọ gọi `GET /:id` → `200 OK` (được xem), nhưng gọi `PATCH /confirm-completion` / `PATCH /reject-completion` → **`404 REPAIR_TICKET_NOT_FOUND`**.
3. **Toàn bộ vòng đời `OPEN → IN_PROGRESS → AWAITING_CONFIRMATION → IN_PROGRESS (reopen 0 ảnh & có ảnh) → AWAITING_CONFIRMATION → CLOSED` (Q2, Q3, Q4, Q5):**
   - Landlord gọi `PATCH /accept` với `scheduledAt = now - 3 phút` → `200 OK` (Q5); với `scheduledAt = now - 10 phút` → `400 VALIDATION_ERROR`.
   - Landlord gọi `PATCH /complete` kèm 2 ảnh `COMPLETION` + `repairCost = 450000` + `costBearer = 'LANDLORD'` → `200` (`AWAITING_CONFIRMATION`, `autoCloseAt = completedAt + 5 ngày`).
   - Tenant gọi `PATCH /reject-completion` lần 1 bằng **JSON 0 ảnh** → `200` (`IN_PROGRESS`, `completedAt === null`, `repairCost === null`, `costBearer === null` — Q3; 0 dòng `RepairAttachment` rác — Q2; `GET /:ticketId` trả đúng `latestRejectionReason` & `reopenHistory.length === 1`).
   - Landlord `complete` lại → Tenant gọi `PATCH /reject-completion` lần 2 bằng **multipart kèm 2 ảnh `REOPEN_EVIDENCE`** → `200`, DB có 2 `RepairAttachment` (`stage = 'REOPEN_EVIDENCE'`, `reason != null`), `reopenHistory.length === 2`.
4. **Luật bảo vệ 72 giờ (`canEscalateToComplaint`):**
   - Cập nhật `createdAt` của 1 ticket `OPEN` lùi về `73 giờ` trước → `GET /:ticketId` và `GET /` đều trả `canEscalateToComplaint === true`.
   - Ticket `OPEN` mới tạo 10 giờ trước → `false`; ticket `IN_PROGRESS` tạo 80 giờ trước → `false`.
5. **Luật tự động đóng 5 ngày (Lazy-check, List Lazy-check, Cron Batch, Q6 & Race Condition):**
   - Tạo ticket `AWAITING_CONFIRMATION` với `completedAt` lùi `5 ngày + 1 phút`:
     - Tenant gọi `PATCH /reject-completion` kèm 1 ảnh → trả **`409 REPAIR_TICKET_AUTO_CLOSED`**, kiểm tra DB xác nhận `status === 'CLOSED'` (đã commit!), có Notification (`REPAIR_TICKET_CLOSED`, `metadata.autoClosed: true`) cho Landlord + các thành viên `ACTIVE` trong phòng + `AuditLog` (`REPAIR_TICKET_AUTO_CLOSED`), VÀ `mediaService.deleteResource` đã xóa ảnh `REOPEN_EVIDENCE` vừa upload.
   - Tạo ticket quá 5 ngày #2: Tenant gọi `PATCH /confirm-completion` → trả **`409 REPAIR_TICKET_AUTO_CLOSED`** (Q6) và DB đã commit `status === 'CLOSED'`.
   - Tạo ticket quá 5 ngày #3: chạy song song `Promise.all([autoCloseStaleRepairTickets(), fetch(PATCH /confirm-completion)])` → chỉ đóng đúng 1 lần, đúng 1 bản ghi `AuditLog` (`REPAIR_TICKET_AUTO_CLOSED`), không trùng Notification.
   - Tạo ticket quá 5 ngày #4: gọi `GET /api/v1/repair-tickets?status=CLOSED` → list lazy-check (Q9) tự đóng ticket #4 và trả về trong danh sách `CLOSED` ngay lập tức.
   - Gọi lại `autoCloseStaleRepairTickets()` lần 2 → `{ scanned: 0, closedCount: 0, skippedCount: 0, failedCount: 0 }`.

- [ ] **Step 2: Run PostgreSQL integration test suite**

Run: `npx tsx --test tests/repair-tickets/repair-ticket-db.integration.test.ts`
Expected: All tests PASS against live PostgreSQL.

- [ ] **Step 3: Commit**

```bash
git add tests/repair-tickets/repair-ticket-db.integration.test.ts
git commit -m "test(repair-tickets): add PostgreSQL integration tests for full lifecycle, Q1-Q9 rules, concurrency and Anti-IDOR"
```

---

### Task 6: Verification Gate & Rà soát trước khi Mở PR

**Files:**
- Verify all files against `AGENTS.md`, `CONTRIBUTING.md`, `docs/openapi/repair-tickets.yaml`.

- [ ] **Step 1: Chạy đầy đủ 5 lệnh kiểm chứng bắt buộc**

```bash
npm run typecheck && npm run build && npm test && npm run db:check && git diff --check
```

Expected: Toàn bộ 5 lệnh thoát với mã `0`, toàn bộ test cũ + mới xanh 100%.

- [ ] **Step 2: Kiểm tra `git status` & ranh giới file chống xung đột**

Run: `git status`
Expected: Chỉ gồm các file trong `docs/superpowers/*`, `docs/openapi/repair-tickets.yaml`, `src/modules/repair-tickets/*`, `tests/repair-tickets/*`, và đúng 3 file chỉnh sửa tối giản (`src/app.ts`, `src/infrastructure/scheduler/phase3-timers.ts`, `src/server.ts`). Không đụng `prisma/schema.prisma`, `package.json`, `phase3-status.ts`, `cloudinary.util.ts`, `notification.util.ts`, hay `src/modules/media/*`.
