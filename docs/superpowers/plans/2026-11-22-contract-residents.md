# [BE-P3-08] Contract Residents & Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai hoàn chỉnh phân hệ Quản lý Thành viên Cư trú & Lời mời ở cùng (`src/modules/residents/`, 7 endpoints P0) tuân thủ `BR-10`, `BR-11`, `UC-15`, khóa hàng `Contract FOR UPDATE` chống race condition, `upsert` cho người cũ quay lại, thông báo In-App cho cả 5 sự kiện và `AuditLog` nguyên tử.

**Architecture:** Layered Modular Monolith (`Routes → Controller → Service → Repository → Prisma Singleton → PostgreSQL`) đặt tại `src/modules/residents/`, tách nhánh từ `origin/staging`. Toàn bộ thao tác ghi trên hợp đồng dùng chung thứ tự khóa duy nhất (`SELECT id FROM contracts WHERE id = $1::uuid FOR UPDATE`) trong `prisma.$transaction`, kết hợp discriminated outcome để commit lazy-expiration (`EXPIRED`) trước khi ném `409 INVITATION_EXPIRED`.

**Tech Stack:** Express 5.3.0, TypeScript (CommonJS), Prisma Client 6.19.3, PostgreSQL, Zod 4.6.7, Node.js Native Test Runner (`node:test`, `node:assert/strict`).

**Spec:** [docs/superpowers/specs/2026-11-22-contract-residents-design.md](../specs/2026-11-22-contract-residents-design.md)
**OpenAPI:** [docs/openapi/contract-residents.yaml](../../openapi/contract-residents.yaml)
**Status:** `Approved (Refine Final — 2026-11-22)`

## Global Constraints

- **Zero DB Schema Drift:** Tuyệt đối không sửa `prisma/schema.prisma`, không chạy `prisma migrate dev` và không tạo migration mới.
- **CommonJS & Prisma Singleton:** Giữ nguyên `"module": "CommonJS"`; chỉ dùng singleton `prisma` từ `src/infrastructure/database/prisma.ts`, không gọi `new PrismaClient()`.
- **Phân tầng bắt buộc:** `resident.service.ts` tuyệt đối không import `prisma` trực tiếp; mọi truy vấn DB đi qua `resident.repository.ts`.
- **Anti-IDOR & Privacy-by-Default (Final Gate #1):** Người ngoài hợp đồng và người ở cùng đã rời phòng (`leftAt != null`) luôn nhận `404` (`CONTRACT_NOT_FOUND` / `INVITATION_NOT_FOUND`). Không bao giờ select/trả về `passwordHash`, `password_hash`, `email`, `phone` trong DTO (chỉ trả `{ id, fullName, avatarUrl }`); không nhận `userId` UUID khi mời.
- **Quy tắc trạng thái hợp đồng & hiển thị lời mời (Final Gate #1):**
  - `GET /api/v1/contracts/:contractId/residents`: trả `pendingInvitations: null` cho `CO_RESIDENT`; vẫn cho phép đọc khi hợp đồng không còn `ACTIVE` (kèm `contractStatus`).
  - `PATCH /reject` & `PATCH /cancel`: vẫn cho phép dọn lời mời `PENDING` còn hạn khi hợp đồng không còn `ACTIVE`; riêng `RESIDENT_INVITATION_REJECTED` chỉ gửi Notification cho `invitedById`.
  - `POST /invitations`, `PATCH /accept`, `DELETE /residents/:userId`: bắt buộc `contract.status === 'ACTIVE'` (`409 CONTRACT_NOT_ACTIVE`).
- **Tương thích & Chống xung đột với PR #40 (`feat/be-p3-07-notifications-api`):**
  - Không chỉnh sửa `src/common/utils/notification.util.ts` và không đụng `src/modules/notifications/*` hay `src/modules/viewing-appointments/*`.
  - Truyền `payload` cho `createNotification` / `createNotificationsBatch` đúng định dạng `{ content, actionUrl, relatedEntityType, relatedEntityId, metadata }`.
  - Khi merge/rebase với `staging` sau khi PR #40 đã merge, bắt buộc ánh xạ 2 hằng số mới (`RESIDENT_INVITATION_REJECTED`, `RESIDENT_INVITATION_CANCELLED`) vào `NOTIFICATION_CATEGORY_BY_EVENT` với nhóm `NOTIFICATION_CATEGORY.BOOKING_CONTRACT`.
- **Single-line Mount trong `src/app.ts`:** Chỉ thêm 1 dòng import `residentRouter` và 1 dòng `app.use(residentRouter);`.
- **Định dạng lỗi thống nhất:** Mọi lỗi nghiệp vụ/validation ném qua `ApiError` (`{ success: false, code, message, errors?, traceId }`).

## Review Focus

1. **Bẫy Transaction Rollback khi Lazy-Expire (`INVITATION_EXPIRED`):** Nếu ném `ApiError` ngay trong `prisma.$transaction` sau khi cập nhật `status = 'EXPIRED'`, PostgreSQL sẽ rollback lệnh cập nhật $\rightarrow$ Bắt buộc commit bằng kết quả `{ outcome: 'EXPIRED' }` rồi mới ném `409 INVITATION_EXPIRED` tại Service (kiểm chứng bằng unit test ở Task 4 và live PostgreSQL integration test đọc lại `status === 'EXPIRED'` trực tiếp từ DB trong Task 6).
2. **Race Condition vượt `maxOccupants` khi `/accept` đồng thời (`BR-11`):** Hai lời mời `PENDING` cùng gọi `PATCH /accept` qua `Promise.all` khi phòng chỉ còn 1 chỗ phải trả đúng `[200, 409 ROOM_CAPACITY_EXCEEDED]` và DB có đúng `maxOccupants - 1` dòng `ContractResident` active (kiểm chứng bằng live PostgreSQL test trong Task 6).
3. **Lỗi trùng Composite PK `@@id([contractId, userId])` khi người cũ quay lại:** Người ở cùng đã bị gỡ / tự rời (`leftAt != null`) khi được mời lại và bấm `/accept` phải `upsert` sạch (`leftAt = null`, cập nhật `joinedAt`), không văng `P2002` (kiểm chứng bằng live PostgreSQL test trong Task 6).
4. **Race Condition trùng lời mời `POST /invitations` & Ranh giới Anti-IDOR:** Hai yêu cầu `POST /invitations` song song cho cùng 1 người được mời (khi không có partial unique index ở DB) phải được tuần tự hóa dưới khóa `Contract FOR UPDATE` trả `[201, 409 INVITATION_ALREADY_PENDING]`; `CO_RESIDENT` nhận `403`, former co-resident & outsider nhận `404`, truyền UUID vào `identifier` nhận `400` (kiểm chứng ở Task 2, Task 4, Task 5, Task 6).
5. **Tương thích hợp đồng `phase3-status.ts` & `AuditLog.entityId` UUID:** 2 hằng số mới phải `<= 40` ký tự (khớp `VARCHAR(40)`), `AuditLog.entityId` luôn là UUID hợp lệ (`invitation.id` cho lời mời, `contractId` cho `ContractResident`), và không tạo notification/audit log mồ côi khi transaction thất bại (kiểm chứng ở Task 1, Task 3, Task 6).

---

## File Structure

- Modify: `src/common/constants/phase3-status.ts` (thêm `RESIDENT_INVITATION_REJECTED`, `RESIDENT_INVITATION_CANCELLED`)
- Modify: `src/app.ts` (mount `residentRouter`)
- Create: `src/modules/residents/resident.types.ts`
- Create: `src/modules/residents/resident.validation.ts`
- Create: `src/modules/residents/resident.mapper.ts`
- Create: `src/modules/residents/resident.repository.ts`
- Create: `src/modules/residents/resident.service.ts`
- Create: `src/modules/residents/resident.controller.ts`
- Create: `src/modules/residents/resident.routes.ts`
- Test: `tests/phase3-shared-infra.test.ts` (bổ sung assert cho 2 event types mới)
- Test: `tests/residents/resident.validation-mapper.test.ts`
- Test: `tests/residents/resident.service.test.ts`
- Test: `tests/residents/resident-api.test.ts`
- Test: `tests/residents/resident-db.integration.test.ts`

---

### Task 1: Bổ sung 2 hằng số Notification Event Type trong `phase3-status.ts`

**Files:**
- Modify: `src/common/constants/phase3-status.ts:101-127`
- Test: `tests/phase3-shared-infra.test.ts`

**Interfaces:**
- Produces in `src/common/constants/phase3-status.ts`:
  - `NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_REJECTED = 'RESIDENT_INVITATION_REJECTED'` (28 chars)
  - `NOTIFICATION_EVENT_TYPE.RESIDENT_INVITATION_CANCELLED = 'RESIDENT_INVITATION_CANCELLED'` (29 chars)
  - *(Ghi chú merge PR #40: nếu `NOTIFICATION_CATEGORY_BY_EVENT` đã có trên nhánh sau khi merge `staging`, thêm cả 2 khóa trên với giá trị `NOTIFICATION_CATEGORY.BOOKING_CONTRACT`.)*

- [ ] **Step 1: Write failing test in `tests/phase3-shared-infra.test.ts`**

Thêm test kiểm tra `NOTIFICATION_EVENT_TYPE` chứa đủ 5 sự kiện của phân hệ cư trú:
- `RESIDENT_INVITATION_RECEIVED`
- `RESIDENT_JOINED`
- `RESIDENT_INVITATION_REJECTED`
- `RESIDENT_INVITATION_CANCELLED`
- `RESIDENT_REMOVED`
và độ dài từng chuỗi `<= 40` ký tự.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/phase3-shared-infra.test.ts`
Expected: FAIL (`RESIDENT_INVITATION_REJECTED` / `RESIDENT_INVITATION_CANCELLED` is `undefined`).

- [ ] **Step 3: Add the 2 constants to `src/common/constants/phase3-status.ts`**

Chỉ chèn đúng 2 dòng ngay dưới `RESIDENT_INVITATION_RECEIVED` trong `NOTIFICATION_EVENT_TYPE` (không sửa dòng nào khác để tối thiểu hóa diff với PR #40). Nếu nhánh đã rebase lên PR #40, đồng thời thêm 2 dòng vào `NOTIFICATION_CATEGORY_BY_EVENT` ánh xạ sang `NOTIFICATION_CATEGORY.BOOKING_CONTRACT`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/phase3-shared-infra.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/common/constants/phase3-status.ts tests/phase3-shared-infra.test.ts
git commit -m "feat(residents): add resident invitation rejected and cancelled notification event types"
```

---

### Task 2: Types, Zod Validation & DTO Mapper (`src/modules/residents/`)

**Files:**
- Create: `src/modules/residents/resident.types.ts`
- Create: `src/modules/residents/resident.validation.ts`
- Create: `src/modules/residents/resident.mapper.ts`
- Test: `tests/residents/resident.validation-mapper.test.ts`

**Interfaces:**
- Produces in `src/modules/residents/resident.types.ts`:
  - `ResidentRole = 'PRIMARY_TENANT' | 'CO_RESIDENT'`
  - `ResidentRemovalType = 'SELF_LEAVE' | 'REMOVED_BY_PRIMARY_TENANT' | 'REMOVED_BY_LANDLORD'`
  - `ParsedInviteIdentifier = { type: 'EMAIL'; value: string } | { type: 'PHONE'; value: string }`
  - `ResidentInvitationListQuery = { status?: ResidentInvitationStatus; page: number; limit: number }`
  - `UserSummaryDTO`, `ResidentItemDTO`, `ContractPendingInvitationDTO`, `ContractResidentsResponseDTO`, `ResidentInvitationCreatedDTO`, `ReceivedResidentInvitationDTO`, `PaginatedResidentInvitationsDTO`, `AcceptResidentInvitationDTO`, `InvitationStatusActionDTO`, `RemoveContractResidentDTO`
  - Raw DB row interfaces cho Mapper & Repository (strict explicit fields, không chứa `passwordHash`).
- Produces in `src/modules/residents/resident.validation.ts`:
  - `validateContractId(contractId: unknown): string`
  - `validateInvitationId(invitationId: unknown): string`
  - `validateUserId(userId: unknown): string`
  - `validateCreateInvitationBody(body: unknown): ParsedInviteIdentifier`
  - `validateInvitationListQuery(query: unknown): ResidentInvitationListQuery`
- Produces in `src/modules/residents/resident.mapper.ts`:
  - `mapContractResidentsResponse(row: ContractResidentsRow, includePendingInvitations: boolean): ContractResidentsResponseDTO`
  - `mapCreatedInvitationResponse(row: CreatedInvitationRow): ResidentInvitationCreatedDTO`
  - `mapReceivedInvitationItem(row: ReceivedInvitationRow): ReceivedResidentInvitationDTO`
  - `mapAcceptInvitationResponse(result: AcceptedInvitationTxResult): AcceptResidentInvitationDTO`
  - `mapRemoveResidentResponse(result: RemovedResidentTxResult): RemoveContractResidentDTO`

- [ ] **Step 1: Write failing tests in `tests/residents/resident.validation-mapper.test.ts`**

Viết các test cases phủ:
- `validateCreateInvitationBody`:
  - Chấp nhận email (`"  User.B@RentMate.VN  "` → `{ type: 'EMAIL', value: 'user.b@rentmate.vn' }`).
  - Chấp nhận SĐT Việt Nam (`" 0901234567 "` → `{ type: 'PHONE', value: '0901234567' }`).
  - Từ chối UUID (`"11111111-2222-4333-8444-555555555555"` → `ApiError 400 VALIDATION_ERROR`).
  - Từ chối body chứa trường thừa (`{ identifier: "a@b.com", userId: "..." }` → `400 VALIDATION_ERROR` do `.strict()`).
  - Từ chối chuỗi rỗng, SĐT sai độ dài/không bắt đầu bằng `0`.
- `validateInvitationListQuery`:
  - Mặc định `{ page: 1, limit: 20, status: undefined }`.
  - Hỗ trợ `pageSize` làm alias của `limit`; truyền cả `limit=10&pageSize=30` ưu tiên `limit=10`.
  - Từ chối `status` ngoài `RESIDENT_INVITATION_STATUS`, `page < 1`, `limit > 50` (`400 VALIDATION_ERROR`).
- `validateContractId`, `validateInvitationId`, `validateUserId`: từ chối chuỗi không phải UUID với `400 VALIDATION_ERROR`.
- `mapContractResidentsResponse`:
  - `residents[0]` luôn là `PRIMARY_TENANT`, tiếp theo là các `CO_RESIDENT`; `currentOccupants = 1 + activeCoResidents.length`, `remainingSlots = Math.max(0, maxOccupants - currentOccupants)`.
  - `includePendingInvitations === true` → trả mảng `pendingInvitations`; `false` → `pendingInvitations === null`.
  - Kiểm tra JSON kết quả không chứa `passwordHash`, `password_hash`, `email`, `phone`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/residents/resident.validation-mapper.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `resident.types.ts`, `resident.validation.ts`, and `resident.mapper.ts`**

- Dùng `z.object(...).strict()` với Zod 4.6.7 (khớp pattern trong `src/modules/rental-requests/rental-request.validation.ts`).
- Dùng `UUID_REGEX` nhất quán với repo; dùng `RESIDENT_INVITATION_STATUS` từ `src/common/constants/phase3-status.ts`.
- Mapper chỉ ánh xạ explicit allowlist `{ id, fullName, avatarUrl }` cho user và ISO strings cho mọi `Date`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/residents/resident.validation-mapper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/residents/resident.types.ts src/modules/residents/resident.validation.ts src/modules/residents/resident.mapper.ts tests/residents/resident.validation-mapper.test.ts
git commit -m "feat(residents): add types, Zod validation, and DTO mappers"
```

---

### Task 3: Triển khai Repository Layer với `Contract FOR UPDATE`, Upsert, Notifications & AuditLog

**Files:**
- Create: `src/modules/residents/resident.repository.ts`

**Interfaces:**
- Consumes:
  - `prisma` từ `src/infrastructure/database/prisma.ts`
  - `CONTRACT_STATUS`, `RESIDENT_INVITATION_STATUS`, `NOTIFICATION_EVENT_TYPE`, `PHASE3_TIME_LIMITS_MS` từ `src/common/constants/phase3-status.ts`
  - `createNotification`, `createNotificationsBatch` từ `src/common/utils/notification.util.ts`
  - `recordAuditLog` từ `src/common/utils/audit-log.util.ts`
  - `ApiError` từ `src/common/errors/api-error.ts`
  - Types từ `src/modules/residents/resident.types.ts`
- Produces (`ResidentRepository` static class hoặc exported object methods):
  - `findContractAccessContext(contractId: string, userId: string): Promise<ContractAccessContext | null>`
  - `expireContractPendingInvitations(contractId: string, now: Date): Promise<number>`
  - `findContractResidentsDetail(contractId: string, includePendingInvitations: boolean, now: Date): Promise<ContractResidentsRow | null>`
  - `createInvitationInTx(params: CreateInvitationTxParams): Promise<CreatedInvitationRow>`
  - `findReceivedInvitations(invitedUserId: string, query: ResidentInvitationListQuery, now: Date): Promise<{ items: ReceivedInvitationRow[]; total: number }>`
  - `findInvitationAccessContext(invitationId: string): Promise<InvitationAccessContext | null>`
  - `acceptInvitationInTx(params: AcceptInvitationTxParams): Promise<{ outcome: 'EXPIRED' } | { outcome: 'ACCEPTED'; data: AcceptedInvitationTxResult }>`
  - `rejectInvitationInTx(params: RejectInvitationTxParams): Promise<{ outcome: 'EXPIRED' } | { outcome: 'REJECTED'; data: { invitationId: string; contractId: string } }>`
  - `cancelInvitationInTx(params: CancelInvitationTxParams): Promise<{ outcome: 'EXPIRED' } | { outcome: 'CANCELLED'; data: { invitationId: string; contractId: string } }>`
  - `removeResidentInTx(params: RemoveResidentTxParams): Promise<RemovedResidentTxResult>`

- [ ] **Step 1: Implement `src/modules/residents/resident.repository.ts`**

Các yêu cầu kỹ thuật bắt buộc trong Repository:
1. Helper nội bộ `lockContractRow(tx: Prisma.TransactionClient, contractId: string)`:
   ```ts
   await tx.$queryRaw`SELECT id FROM contracts WHERE id = ${contractId}::uuid FOR UPDATE`;
   ```
   Gọi làm bước **đầu tiên** bên trong `$transaction` của cả 5 thao tác ghi (`createInvitationInTx`, `acceptInvitationInTx`, `rejectInvitationInTx`, `cancelInvitationInTx`, `removeResidentInTx`) để bảo đảm thứ tự khóa duy nhất (zero deadlock).
2. **`createInvitationInTx`:**
   - Khóa `contracts` `FOR UPDATE` → đọc lại `contract` + `room` + `property` → kiểm tra `contract.status === 'ACTIVE'` (`409 CONTRACT_NOT_ACTIVE`).
   - Tra cứu target user theo `identifier.type === 'EMAIL'` (`email: { equals: value, mode: 'insensitive' }`) hoặc `'PHONE'` (`phone: value`), chỉ `select: { id, fullName, avatarUrl, role, accountStatus }`:
     - Không tồn tại → `404 INVITEE_NOT_FOUND`.
     - `role !== 'TENANT' || accountStatus !== 'ACTIVE'` → `400 INVITEE_NOT_ELIGIBLE`.
   - Kiểm tra `targetUser.id === contract.tenantId` (`409 ALREADY_PRIMARY_TENANT`).
   - Kiểm tra active `ContractResident` (`leftAt: null`) (`409 ALREADY_RESIDENT`).
   - Chuyển mọi `PENDING` cũ quá hạn (`expiresAt <= now`) của `(contractId, targetUser.id)` sang `EXPIRED`.
   - Kiểm tra còn `PENDING` chưa hết hạn (`expiresAt > now`) của `(contractId, targetUser.id)` → `409 INVITATION_ALREADY_PENDING`.
   - Đếm `activeCoResidents` dưới khóa: `1 + activeCoResidents >= room.maxOccupants` → `409 ROOM_CAPACITY_EXCEEDED`.
   - Tạo `ResidentInvitation` (`status: 'PENDING'`, `expiresAt: new Date(now.getTime() + PHASE3_TIME_LIMITS_MS.RESIDENT_INVITATION_TTL_MS)`).
   - Gọi `createNotification(tx, ...)` (`RESIDENT_INVITATION_RECEIVED`, payload chuẩn PR #40) cho `targetUser.id`.
   - Gọi `recordAuditLog(tx, ...)` (`entityType: 'RESIDENT_INVITATION'`, `entityId: invitation.id`, `action: 'RESIDENT_INVITATION_CREATED'`).
3. **`findReceivedInvitations`:**
   - Chạy `updateMany` chuyển các lời mời `PENDING` có `invitedUserId` và `expiresAt <= now` sang `EXPIRED` TRƯỚC khi chạy song song `findMany` (orderBy `[{ expiresAt: 'desc' }, { id: 'desc' }]`, `skip`, `take`) và `count`.
4. **`acceptInvitationInTx`:**
   - Khóa `contracts` `FOR UPDATE` → đọc lại `invitation` + `contract` + `room` + `property` + `invitedUser`.
   - Kiểm tra `invitation.invitedUserId === actor.id` (`404 INVITATION_NOT_FOUND`).
   - Nếu `status === 'EXPIRED'` → ném `409 INVITATION_EXPIRED`; nếu `status !== 'PENDING'` → ném `409 INVITATION_NOT_PENDING`.
   - Nếu `expiresAt <= now`: update `status = 'EXPIRED'` và **`return { outcome: 'EXPIRED' }`** (COMMIT, không throw trong tx!).
   - Kiểm tra `contract.status === 'ACTIVE'` (`409 CONTRACT_NOT_ACTIVE`), defensive guard `ALREADY_PRIMARY_TENANT` & `ALREADY_RESIDENT`.
   - Đếm lại `activeCoResidents` dưới khóa → nếu `1 + activeCoResidents >= room.maxOccupants` ném `409 ROOM_CAPACITY_EXCEEDED`.
   - Đọc `existingResident` (nếu có) để ghi `oldData` chuẩn → `tx.contractResident.upsert({ where: { contractId_userId: { contractId, userId: actor.id } }, create: { contractId, userId: actor.id, joinedAt: now, leftAt: null }, update: { joinedAt: now, leftAt: null } })`.
   - Cập nhật `ResidentInvitation`: `status = 'ACCEPTED'`, `acceptedAt = now`.
   - Gửi `createNotificationsBatch(tx, ...)` (`RESIDENT_JOINED`) tới Chủ HĐ & Chủ trọ (deduplicated, `actionUrl` theo từng vai trò).
   - Gọi `recordAuditLog(tx, ...)` (`entityType: 'RESIDENT_INVITATION'`, `entityId: invitation.id`, `action: 'RESIDENT_INVITATION_ACCEPTED'`).
5. **`rejectInvitationInTx` & `cancelInvitationInTx`:**
   - Khóa `contracts` `FOR UPDATE` → đọc lại `invitation` → kiểm tra trạng thái & lazy-expire bằng `{ outcome: 'EXPIRED' }` (COMMIT trước khi throw ở Service).
   - Cập nhật `status` sang `'REJECTED'` / `'CANCELLED'`.
   - Gọi `createNotification(tx, ...)` (`RESIDENT_INVITATION_REJECTED` cho `invitedById`; `RESIDENT_INVITATION_CANCELLED` cho `invitedUserId`) với payload chuẩn PR #40.
   - Gọi `recordAuditLog(tx, ...)` (`entityType: 'RESIDENT_INVITATION'`, `entityId: invitation.id`).
6. **`removeResidentInTx`:**
   - Khóa `contracts` `FOR UPDATE` → đọc lại `contract` + `room` + `property` → kiểm tra `contract.status === 'ACTIVE'` (`409 CONTRACT_NOT_ACTIVE`).
   - Tìm `ContractResident` với `{ contractId, userId: targetUserId, leftAt: null }` (kèm `user: { select: { id, fullName } }`) → nếu không có ném `404 RESIDENT_NOT_FOUND`.
   - Cập nhật `leftAt = now`.
   - Đếm lại `currentOccupants = 1 + activeCoResidentsAfter`.
   - Gửi `createNotificationsBatch(tx, ...)` (`RESIDENT_REMOVED`) cho **cả 3 actor** (deduplicated: `landlordId`, `contract.tenantId`, `targetUserId`; riêng `targetUserId` dùng `actionUrl: '/contracts'`).
   - Gọi `recordAuditLog(tx, ...)` (`entityType: 'CONTRACT_RESIDENT'`, `entityId: contractId`, `action: isSelfLeave ? 'RESIDENT_SELF_LEFT' : 'RESIDENT_REMOVED'`).

- [ ] **Step 2: Run typecheck to verify Repository compiles cleanly**

Run: `npm run typecheck`
Expected: 0 TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/residents/resident.repository.ts
git commit -m "feat(residents): implement repository with contract row locking, PK upsert, notifications and audit logs"
```

---

### Task 4: Triển khai Service Layer & Unit Tests phân quyền / Anti-IDOR / Boundary

**Files:**
- Create: `src/modules/residents/resident.service.ts`
- Test: `tests/residents/resident.service.test.ts`

**Interfaces:**
- Consumes: `ResidentRepository` (Task 3), Mapper functions (Task 2), `CurrentUser` (`src/common/middleware/require-role.ts`), `ApiError`.
- Produces (`ResidentService`):
  - `getContractResidents(contractId: string, currentUser: CurrentUser): Promise<ContractResidentsResponseDTO>`
  - `createInvitation(contractId: string, identifier: ParsedInviteIdentifier, currentUser: CurrentUser): Promise<ResidentInvitationCreatedDTO>`
  - `listMyInvitations(query: ResidentInvitationListQuery, currentUser: CurrentUser): Promise<PaginatedResidentInvitationsDTO>`
  - `acceptInvitation(invitationId: string, currentUser: CurrentUser): Promise<AcceptResidentInvitationDTO>`
  - `rejectInvitation(invitationId: string, currentUser: CurrentUser): Promise<InvitationStatusActionDTO>`
  - `cancelInvitation(invitationId: string, currentUser: CurrentUser): Promise<InvitationStatusActionDTO>`
  - `removeResident(contractId: string, targetUserId: string, currentUser: CurrentUser): Promise<RemoveContractResidentDTO>`

- [ ] **Step 1: Write failing unit tests in `tests/residents/resident.service.test.ts`**

Viết unit tests (mock các phương thức trên `ResidentRepository`, khôi phục trong `finally` khớp pattern `tests/service.test.ts`):
- Static architecture guard: đọc nội dung `src/modules/residents/resident.service.ts` và assert không import `infrastructure/database/prisma` hay gọi `prisma.`.
- `getContractResidents`:
  - Primary Tenant / Landlord → gọi `expireContractPendingInvitations` + `findContractResidentsDetail(..., true)` → trả kèm `pendingInvitations` array.
  - Active Co-Resident → gọi `findContractResidentsDetail(..., false)` → trả `pendingInvitations: null`.
  - Outsider hoặc Former Co-Resident → ném `404 CONTRACT_NOT_FOUND`.
- `createInvitation`:
  - Active Co-Resident → ném `403 FORBIDDEN`.
  - Outsider / hợp đồng không tồn tại → ném `404 CONTRACT_NOT_FOUND`.
  - Primary Tenant / Landlord → ủy quyền `createInvitationInTx` và map response.
- `acceptInvitation` / `rejectInvitation` / `cancelInvitation`:
  - Người không thuộc quyền (ví dụ user khác gọi `/accept` hoặc `/reject`; `CO_RESIDENT` hoặc outsider gọi `/cancel`) → ném `404 INVITATION_NOT_FOUND`.
  - Repository trả `{ outcome: 'EXPIRED' }` → Service ném `409 INVITATION_EXPIRED`.
  - Repository trả thành công → Service trả đúng DTO.
- `removeResident`:
  - Outsider → `404 CONTRACT_NOT_FOUND`.
  - `CO_RESIDENT` cố gỡ người khác (kể cả Primary Tenant hoặc Co-Resident khác) → `403 FORBIDDEN`.
  - Primary Tenant / Landlord cố gỡ `contract.tenantId` → `400 CANNOT_REMOVE_PRIMARY_TENANT`.
  - `CO_RESIDENT` tự rời phòng (`targetUserId === currentUser.id`) → gọi `removeResidentInTx` với `removalType = 'SELF_LEAVE'`.
  - Primary Tenant / Landlord gỡ `CO_RESIDENT` → gọi `removeResidentInTx` với `REMOVED_BY_PRIMARY_TENANT` / `REMOVED_BY_LANDLORD`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/residents/resident.service.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/modules/residents/resident.service.ts`**

Triển khai toàn bộ 7 phương thức sạch sẽ, không import `prisma`, thực thi đúng thứ tự kiểm tra quyền & Anti-IDOR trong Spec Mục 5.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/residents/resident.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/residents/resident.service.ts tests/residents/resident.service.test.ts
git commit -m "feat(residents): implement service layer with Anti-IDOR authorization and unit tests"
```

---

### Task 5: Controller, Routes, Mount `src/app.ts` & HTTP API Tests

**Files:**
- Create: `src/modules/residents/resident.controller.ts`
- Create: `src/modules/residents/resident.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/residents/resident-api.test.ts`

**Interfaces:**
- Consumes: `ResidentService` (Task 4), Validation functions (Task 2), `requireRole` (`src/common/middleware/require-role.ts`).
- Produces:
  - `residentRouter` (Express `Router`) với 7 routes:
    - `GET /api/v1/contracts/:contractId/residents` (`requireRole('TENANT', 'LANDLORD')`)
    - `POST /api/v1/contracts/:contractId/invitations` (`requireRole('TENANT', 'LANDLORD')`)
    - `DELETE /api/v1/contracts/:contractId/residents/:userId` (`requireRole('TENANT', 'LANDLORD')`)
    - `GET /api/v1/resident-invitations` (`requireRole('TENANT')`)
    - `PATCH /api/v1/resident-invitations/:invitationId/accept` (`requireRole('TENANT')`)
    - `PATCH /api/v1/resident-invitations/:invitationId/reject` (`requireRole('TENANT')`)
    - `PATCH /api/v1/resident-invitations/:invitationId/cancel` (`requireRole('TENANT', 'LANDLORD')`)
  - Mount `app.use(residentRouter);` trong `src/app.ts`.

- [ ] **Step 1: Write failing HTTP tests in `tests/residents/resident-api.test.ts`**

Khởi chạy `http.createServer(app)` với `signAccessToken`, mock `prisma.user.findUnique` (hoặc dùng stub hợp lý như `tests/viewing-appointment-api.test.ts` / `tests/rental-request-api.test.ts`) và `ResidentService`:
- Thiếu token → `401 UNAUTHORIZED` trên cả 7 endpoints.
- Tài khoản `LOCKED` → `403 ACCOUNT_LOCKED`.
- `ADMIN` gọi bất kỳ endpoint nào → `403 FORBIDDEN`; `LANDLORD` gọi `GET /resident-invitations`, `/accept`, `/reject` → `403 FORBIDDEN`.
- Path param UUID không hợp lệ (`contractId`, `invitationId`, `userId`) → `400 VALIDATION_ERROR`.
- Body `POST /invitations` truyền UUID hoặc thiếu `identifier` → `400 VALIDATION_ERROR`.
- Happy paths trả đúng HTTP status (`201` cho `POST /invitations`, `200` cho 6 endpoints còn lại) và khớp shape JSON OpenAPI.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/residents/resident-api.test.ts`
Expected: FAIL (404 route not mounted / module not found).

- [ ] **Step 3: Implement `resident.controller.ts`, `resident.routes.ts` and mount in `src/app.ts`**

- Controller trích `res.locals.currentUser` (nếu thiếu ném `401 UNAUTHORIZED`), validate params/query/body, gọi `ResidentService`, trả `201` cho `createInvitation` và `200` cho các endpoint còn lại.
- Đăng ký `residentRouter` trong `src/app.ts` đúng 1 dòng import + 1 dòng `app.use(residentRouter);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/residents/resident-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/residents/resident.controller.ts src/modules/residents/resident.routes.ts src/app.ts tests/residents/resident-api.test.ts
git commit -m "feat(residents): add controller, routes, app mount, and HTTP API tests"
```

---

### Task 6: PostgreSQL Live DB Integration Tests (Concurrency, PK Upsert, Lazy Expiry, Notifications & AuditLog)

**Files:**
- Create: `tests/residents/resident-db.integration.test.ts`

**Interfaces:**
- Consumes: `app` (`src/app.ts`), `prisma` (`src/infrastructure/database/prisma.ts`), `signAccessToken` (`src/modules/auth/auth.security.ts`), `CONTRACT_STATUS`, `RESIDENT_INVITATION_STATUS`, `NOTIFICATION_EVENT_TYPE`.

- [ ] **Step 1: Write comprehensive PostgreSQL Integration Tests in `tests/residents/resident-db.integration.test.ts`**

Tuân thủ pattern kết nối + cleanup `try ... finally` của `tests/rental-request-db.integration.test.ts` (skip có thông báo rõ nếu PostgreSQL không khả dụng, dọn sạch toàn bộ `auditLog`, `notification`, `residentInvitation`, `contractResident`, `contract`, `room`, `property`, `user` đã tạo trong test):

1. **Concurrency `/accept` (`BR-11`):**
   - Tạo phòng `maxOccupants = 2`, hợp đồng `ACTIVE` cho Primary Tenant A (còn đúng 1 chỗ).
   - Chủ HĐ gửi 2 lời mời cho Tenant B và Tenant C.
   - B và C gọi `PATCH /api/v1/resident-invitations/:id/accept` song song bằng `Promise.all`.
   - Assert: tập status sắp xếp là `[200, 409]`, response `409` có `code === 'ROOM_CAPACITY_EXCEEDED'`; DB có đúng 1 `ContractResident` `leftAt IS NULL`; `GET /contracts/:id/residents` trả `currentOccupants === 2, maxOccupants === 2, remainingSlots === 0`; có đúng 2 `Notification` (`RESIDENT_JOINED` cho Chủ HĐ & Chủ trọ) và đúng 1 `AuditLog` (`RESIDENT_INVITATION_ACCEPTED`).
2. **Concurrency `POST /invitations` (chống trùng `PENDING`):**
   - Chủ HĐ và Chủ trọ cùng gọi `POST /api/v1/contracts/:id/invitations` song song bằng `Promise.all` cho cùng Tenant B.
   - Assert: tập status `[201, 409]`, lỗi `409` có `code === 'INVITATION_ALREADY_PENDING'`, DB chỉ có đúng 1 dòng `ResidentInvitation` `PENDING` cho `(contractId, B.id)`.
3. **Composite PK Upsert (Rejoin flow):**
   - Gỡ Tenant B (`DELETE /api/v1/contracts/:id/residents/:bId` → `200 OK`, kiểm tra `leftAt != null` trong DB).
   - Mời lại Tenant B (`POST /invitations` → `201`) → Tenant B bấm `/accept` (`200 OK`).
   - Assert: không lỗi trùng PK `@@id([contractId, userId])`, dòng `ContractResident` có `leftAt === null`, `currentOccupants === 2`.
4. **Lazy Expiration Persistence (chứng minh không bị rollback):**
   - Tạo lời mời `PENDING` có `expiresAt = new Date(Date.now() - 60_000)`.
   - Gọi `/accept` (và test tương tự cho `/reject`, `/cancel`) → trả `409 INVITATION_EXPIRED`.
   - Đọc trực tiếp từ `prisma.residentInvitation.findUnique` → assert `status === 'EXPIRED'` (xác nhận đã commit!).
   - Mời lại cùng user sau khi đã hết hạn → `201 Created`.
   - Kiểm tra `GET /api/v1/resident-invitations?status=PENDING` không chứa lời mời quá hạn, trong khi `?status=EXPIRED` có chứa nó.
5. **BR-10, Self-leave, Anti-IDOR & 5 Notification Events + AuditLog:**
   - Chủ HĐ / Chủ trọ cố `DELETE .../residents/{primaryTenantId}` → `400 CANNOT_REMOVE_PRIMARY_TENANT`.
   - `CO_RESIDENT` gọi `POST /invitations` → `403 FORBIDDEN`; gọi `DELETE` người ở cùng khác → `403 FORBIDDEN`; gọi `GET /contracts/:id/residents` → `200` với `pendingInvitations === null`.
   - `CO_RESIDENT` tự rời phòng (`DELETE .../residents/{selfId}`) → `200` (`removalType: 'SELF_LEAVE'`), kiểm tra DB có đủ **3 bản ghi Notification `RESIDENT_REMOVED`** (Chủ trọ, Chủ HĐ, chính Người ở cùng) với payload chuẩn PR #40 (`content`, `actionUrl`, `relatedEntityType`, `relatedEntityId`, `metadata`), và có `AuditLog` (`action: 'RESIDENT_SELF_LEFT'`, `entityId === contractId`).
   - Former Co-Resident (`leftAt != null`) gọi `GET /contracts/:id/residents` → `404 CONTRACT_NOT_FOUND`.
   - Reject & Cancel flow: kiểm tra trạng thái `REJECTED` / `CANCELLED`, kiểm tra Notification `RESIDENT_INVITATION_REJECTED` (chỉ tạo đúng 1 bản ghi gửi riêng cho `invitedById`) và `RESIDENT_INVITATION_CANCELLED` (cho người được mời), kiểm tra `AuditLog`.
   - Non-`ACTIVE` contract (ví dụ `LIQUIDATING`): kiểm tra `GET /contracts/:id/residents`, `PATCH /reject` và `PATCH /cancel` (với lời mời `PENDING` còn hạn) thành công `200 OK`; trong khi `POST /invitations`, `PATCH /accept` và `DELETE /residents/:userId` đều trả `409 CONTRACT_NOT_ACTIVE`.

- [ ] **Step 2: Run PostgreSQL integration test suite**

Run: `npx tsx --test tests/residents/resident-db.integration.test.ts`
Expected: All tests PASS against live PostgreSQL (0 skipped when DB is running).

- [ ] **Step 3: Commit**

```bash
git add tests/residents/resident-db.integration.test.ts
git commit -m "test(residents): add PostgreSQL integration tests for concurrency, PK upsert, expiry, Anti-IDOR and notifications"
```

---

### Task 7: Verification Gate & Rà soát trước khi báo cáo

**Files:**
- Verify all modified/created files against `AGENTS.md`, `CONTRIBUTING.md`, `docs/openapi/contract-residents.yaml`.

- [ ] **Step 1: Chạy đầy đủ 5 lệnh kiểm chứng bắt buộc**

```bash
npm run typecheck && npm run build && npm test && npm run db:check && git diff --check
```

Expected:
- `npm run typecheck`: exit 0 (0 lỗi TypeScript)
- `npm run build`: exit 0 (biên dịch `dist/` thành công)
- `npm test`: exit 0 (toàn bộ test cũ + mới PASS 100%)
- `npm run db:check`: exit 0 (kết nối PostgreSQL thành công)
- `git diff --check`: exit 0 (không lỗi trailing whitespace / conflict markers)

- [ ] **Step 2: Kiểm tra `git status` & phạm vi file**

Run: `git status`
Expected: Chỉ gồm các file trong `docs/superpowers/*`, `docs/openapi/contract-residents.yaml`, `src/common/constants/phase3-status.ts`, `src/app.ts`, `src/modules/residents/*`, `tests/phase3-shared-infra.test.ts`, `tests/residents/*`. Không có thay đổi trên `prisma/schema.prisma`, `package.json`, `notification.util.ts` hay module của thành viên khác.
