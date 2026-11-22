# [BE-P3-07] In-App Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây dựng hoàn chỉnh phân hệ Quản lý Thông báo In-App (`GET /notifications`, `/unread-count`, `GET /:id`, `PATCH /:id/read`, `PATCH /read-all`), chuẩn hóa hợp đồng `category` + `NotificationPayload` dùng chung cho toàn team, và tích hợp phát thông báo cho 4 hành động của `viewing-appointments`.

**Architecture:** Layered Modular Monolith (`Routes → Controller → Service → Repository → Prisma Singleton → PostgreSQL`) đặt tại `src/modules/notifications/`. Không thay đổi Prisma Schema; ánh xạ `eventType → category` và trích xuất `content`/`actionUrl`/`relatedEntity*` từ `payload` JSONB ở tầng mapper + constants dùng chung.

**Tech Stack:** Express 5.3.0, TypeScript (CommonJS), Prisma Client 6.19.3, PostgreSQL, Zod 4.6.7, Node.js Native Test Runner (`node:test`, `node:assert/strict`).

**Spec:** [docs/superpowers/specs/2026-11-22-notifications-design.md](file:///C:/Users/ADMIN/orca/workspaces/backend/staging/docs/superpowers/specs/2026-11-22-notifications-design.md)

## Global Constraints

- **Zero DB Schema Drift:** Tuyệt đối không sửa `prisma/schema.prisma` và không tạo migration mới.
- **CommonJS & Prisma Singleton:** Giữ nguyên `"module": "CommonJS"`; chỉ dùng `prisma` từ `src/infrastructure/database/prisma.ts`.
- **Phân tầng bắt buộc:** Service không được import `prisma` trực tiếp; mọi truy vấn đi qua Repository.
- **Anti-IDOR:** Mọi truy vấn/cập nhật theo `notificationId` đều lọc theo `recipientId = currentUser.id`; không thuộc quyền hoặc không tồn tại trả `404 NOTIFICATION_NOT_FOUND`.
- **Auth Middleware:** Dùng `requireActiveUser()` từ `src/common/middleware/require-role.ts` (không tin `userId` từ query/body).
- **Code Ownership:** Không chỉnh sửa `src/modules/rental-requests/` (thuộc phối hợp với `#33` của `@jack1e2401`).
- **Định dạng lỗi thống nhất:** Mọi lỗi ném qua `ApiError` (`{ success: false, code, message, errors?, traceId }`).

## Review Focus

1. **Express 5 route shadowing:** Nếu đặt `/:notificationId` trước `/unread-count` hoặc `/read-all`, Express sẽ hiểu `"unread-count"` là `:notificationId` và trả `400` invalid UUID $\rightarrow$ Test HTTP phải gọi trực tiếp `/unread-count` và `/read-all` xác nhận trả `200`.
2. **Idempotent & Race-safe `GET /:notificationId`:** Gọi mở chi tiết thông báo chưa đọc chỉ nên cập nhật `isRead = true` và đếm `unreadCount` mới chính xác, không lỗi nếu gọi lặp lại nhiều lần hoặc mở đồng thời $\rightarrow$ Test kiểm tra cả lần 1 (`isRead: true`, `unreadCount` giảm) lẫn lần 2 (`200 OK`, `unreadCount` không giảm thêm).
3. **Unknown `eventType` / Legacy `payload` resilience:** Nếu một bản ghi cũ hoặc module khác ghi `eventType` chưa có trong map hoặc `payload` là `null` / không phải plain object $\rightarrow$ Mapper không được throw, phải fallback `category = 'SYSTEM'` và `content = null`, `actionUrl = null`.
4. **`category` + `eventType` cross-filtering:** Khi client truyền đồng thời `category = 'FINANCE'` và `eventType = 'REPAIR_TICKET_CREATED'` (không khớp nhóm), query không được trả nhầm thông báo của nhóm khác $\rightarrow$ Repository phải giao 2 điều kiện thay vì ghi đè nhau.
5. **Atomicity của `viewing-appointments` notifications:** Khi `rejectAppointment` hoặc `cancelAppointment` bị conflict `409` (`count === 0`) hoặc `confirmAppointmentInTx` bị `P2034` rollback, tuyệt đối không được tạo bản ghi notification mồ côi $\rightarrow$ Test phải xác nhận `notification.count === 0` khi giao dịch thất bại.

---

### Task 1: Chuẩn hóa `NOTIFICATION_CATEGORY`, `NOTIFICATION_EVENT_TYPE` & `NotificationPayload` dùng chung

**Files:**
- Modify: `src/common/constants/phase3-status.ts:101-127`
- Modify: `src/common/utils/notification.util.ts:1-61`
- Test: `tests/phase3-shared-infra.test.ts`

**Interfaces:**
- Produces in `src/common/constants/phase3-status.ts`:
  - `NOTIFICATION_CATEGORY` (`BOOKING_CONTRACT`, `FINANCE`, `REPAIR`, `SYSTEM`) & type `NotificationCategory`
  - `NOTIFICATION_EVENT_TYPE` (bổ sung `VIEWING_APPOINTMENT_CREATED`, `VIEWING_APPOINTMENT_CONFIRMED`, `VIEWING_APPOINTMENT_REJECTED`, `VIEWING_APPOINTMENT_CANCELLED`, `RENTAL_REQUEST_CREATED`, `RENTAL_REQUEST_REJECTED`)
  - `NOTIFICATION_CATEGORY_BY_EVENT: Readonly<Record<string, NotificationCategory>>`
  - `getNotificationCategory(eventType: string): NotificationCategory`
  - `getEventTypesByCategory(category: NotificationCategory): readonly string[]`
- Produces in `src/common/utils/notification.util.ts`:
  - `export interface NotificationPayload { content?: string; actionUrl?: string; relatedEntityType?: string; relatedEntityId?: string; metadata?: Record<string, unknown>; }`
  - Updated `CreateNotificationInput` accepting `NotificationPayload | Prisma.InputJsonValue | null` and clamping/normalizing `title` safely within `200` chars.

- [ ] **Step 1: Write failing tests for category mapping, VARCHAR(40) bounds, and `NotificationPayload` title normalization**

Thêm test vào `tests/phase3-shared-infra.test.ts`:
- Kiểm tra mọi `NOTIFICATION_EVENT_TYPE` mới & cũ đều có mặt trong `NOTIFICATION_CATEGORY_BY_EVENT` và `<= 40` ký tự.
- Kiểm tra `getNotificationCategory('DEPOSIT_CONFIRMED') === 'FINANCE'`, `getNotificationCategory('UNKNOWN_FUTURE_EVENT') === 'SYSTEM'`.
- Kiểm tra `getEventTypesByCategory('REPAIR')` chứa đủ 5 sự kiện `REPAIR_TICKET_*` và không chứa sự kiện nhóm khác.
- Kiểm tra `normalizeNotificationTitle('a'.repeat(250)).length <= 200`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/phase3-shared-infra.test.ts`  
Expected: FAIL (`NOTIFICATION_CATEGORY` / `getNotificationCategory` is not exported).

- [ ] **Step 3: Implement category constants, mappings, and typed `NotificationPayload`**

- Cập nhật `src/common/constants/phase3-status.ts`: thêm `NOTIFICATION_CATEGORY`, 6 event types Viewing/Rental mới, `NOTIFICATION_CATEGORY_BY_EVENT`, `getNotificationCategory`, `getEventTypesByCategory`.
- Cập nhật `src/common/utils/notification.util.ts`: xuất `NotificationPayload`, `normalizeNotificationTitle(title: string): string` (trim + cắt an toàn tối đa 200 ký tự), áp dụng trong `createNotification` và `createNotificationsBatch`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/phase3-shared-infra.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/common/constants/phase3-status.ts src/common/utils/notification.util.ts tests/phase3-shared-infra.test.ts
git commit -m "feat(notifications): standardize categories, event types, and typed payload contract"
```

---

### Task 2: Soạn đặc tả OpenAPI 3.1 `docs/openapi/notifications.yaml` (Contract-First)

**Files:**
- Create: `docs/openapi/notifications.yaml`

**Interfaces:**
- Produces: Đặc tả OpenAPI 3.1 đầy đủ cho 5 endpoints (`/api/v1/notifications`, `/unread-count`, `/read-all`, `/{notificationId}`, `/{notificationId}/read`), BearerAuth, `ApiError` responses (`400`, `401`, `403`, `404`, `500`), ví dụ success/error.

- [ ] **Step 1: Write `docs/openapi/notifications.yaml`**

Tham chiếu cấu trúc từ `docs/openapi/viewing-appointments.yaml`: định nghĩa đầy đủ query params (`page`, `limit`, `pageSize`, `isRead`, `category`, `eventType`), schemas `NotificationItem`, `PaginatedNotificationsResponse`, `UnreadCountResponse`, `NotificationDetailResponse`, `MarkAllReadResponse`, và `ApiErrorResponse`.

- [ ] **Step 2: Validate YAML syntax & `$ref` integrity**

Run:
```powershell
node -e "const fs=require('fs'); const y=fs.readFileSync('docs/openapi/notifications.yaml','utf8'); if(!y.includes('openapi: 3.1.0') || !y.includes('/api/v1/notifications/read-all')) process.exit(1); console.log('OpenAPI OK, lines:', y.split('\n').length);"
```
Expected: `OpenAPI OK` with non-zero lines, no missing refs.

- [ ] **Step 3: Commit**

```bash
git add docs/openapi/notifications.yaml
git commit -m "docs(notifications): add OpenAPI 3.1 specification for In-App notifications"
```

---

### Task 3: Types, Validation & Mapper (`src/modules/notifications/`)

**Files:**
- Create: `src/modules/notifications/notification.types.ts`
- Create: `src/modules/notifications/notification.validation.ts`
- Create: `src/modules/notifications/notification.mapper.ts`
- Test: `tests/notifications/notification.validation-mapper.test.ts`

**Interfaces:**
- Consumes: `NotificationCategory`, `NOTIFICATION_CATEGORY`, `getNotificationCategory` from `src/common/constants/phase3-status.ts`; `ApiError` from `src/common/errors/api-error.ts`.
- Produces:
  - `NotificationListQuery`, `NotificationItemDTO`, `PaginatedNotificationsDTO`, `UnreadCountDTO`, `NotificationActionResponseDTO` (`NotificationItemDTO & { unreadCount: number }`), `MarkAllNotificationsReadDTO`
  - `validateNotificationId(rawId: unknown): string`
  - `validateNotificationListQuery(rawQuery: unknown): NotificationListQuery`
  - `mapToNotificationDTO(row: NotificationRecord): NotificationItemDTO`

- [ ] **Step 1: Write failing unit tests for validation & mapper**

Tạo `tests/notifications/notification.validation-mapper.test.ts`:
- `validateNotificationId`: chấp nhận UUID hợp lệ, ném `ApiError(400, 'VALIDATION_ERROR')` với chuỗi sai UUID.
- `validateNotificationListQuery`: giá trị mặc định `page = 1, limit = 20`; alias `pageSize = 15` hoạt động khi không truyền `limit`; chặn `limit > 50` hoặc `page <= 0` với `400`; parse `isRead = 'true' | 'false'` thành boolean; chấp nhận `category` hợp lệ (`BOOKING_CONTRACT | FINANCE | REPAIR | SYSTEM`) và từ chối giá trị sai với `400`; chấp nhận `eventType` hợp lệ theo regex `^[A-Z0-9_]{1,40}$` (kể cả sự kiện tương lai như `INVOICE_ISSUED`) và từ chối chuỗi sai định dạng/quá 40 ký tự với `400`.
- `mapToNotificationDTO`: trích đúng `content`, `actionUrl`, `relatedEntityType`, `relatedEntityId` từ `payload` hợp lệ; khi `payload` là `null` hoặc primitive/mảng → trả `content: null`, `actionUrl: null`, `payload: null`; khi `eventType` lạ → fallback `category: 'SYSTEM'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/notifications/notification.validation-mapper.test.ts`  
Expected: FAIL (Cannot find module)

- [ ] **Step 3: Implement `notification.types.ts`, `notification.validation.ts`, `notification.mapper.ts`**

Triển khai theo đúng signature đã định nghĩa ở Interfaces (dùng `zod` khớp style `viewing-appointment.validation.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/notifications/notification.validation-mapper.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/notifications/notification.types.ts src/modules/notifications/notification.validation.ts src/modules/notifications/notification.mapper.ts tests/notifications/notification.validation-mapper.test.ts
git commit -m "feat(notifications): add types, Zod validation, and DTO mapper"
```

---

### Task 4: Repository & Service (`src/modules/notifications/`)

**Files:**
- Create: `src/modules/notifications/notification.repository.ts`
- Create: `src/modules/notifications/notification.service.ts`
- Test: `tests/notifications/notification.repo-service.test.ts`

**Interfaces:**
- Consumes: `prisma` (`src/infrastructure/database/prisma.ts`), `getEventTypesByCategory` (`phase3-status.ts`), `mapToNotificationDTO`, `NotificationListQuery`.
- Produces:
  - `NotificationRepository.findNotificationsList(recipientId: string, query: NotificationListQuery): Promise<{ items: NotificationRecord[]; total: number; unreadCount: number }>`
  - `NotificationRepository.countUnread(recipientId: string): Promise<number>`
  - `NotificationRepository.findByIdAndMarkRead(recipientId: string, notificationId: string): Promise<{ notification: NotificationRecord; unreadCount: number } | null>`
  - `NotificationRepository.markOneAsRead(recipientId: string, notificationId: string): Promise<{ notification: NotificationRecord; unreadCount: number } | null>`
  - `NotificationRepository.markAllAsRead(recipientId: string): Promise<{ updatedCount: number; unreadCount: number }>`
  - `NotificationService.getNotifications(recipientId: string, query: NotificationListQuery): Promise<PaginatedNotificationsDTO>`
  - `NotificationService.getUnreadCount(recipientId: string): Promise<UnreadCountDTO>`
  - `NotificationService.getNotificationDetail(recipientId: string, notificationId: string): Promise<NotificationActionResponseDTO>`
  - `NotificationService.markAsRead(recipientId: string, notificationId: string): Promise<NotificationActionResponseDTO>`
  - `NotificationService.markAllAsRead(recipientId: string): Promise<MarkAllNotificationsReadDTO>`

- [ ] **Step 1: Write failing unit tests for Repository query building & Service orchestration**

Tạo `tests/notifications/notification.repo-service.test.ts`:
- Kiểm tra `notification.service.ts` **không** import `prisma` trực tiếp (scan file source bằng `fs.readFileSync`, giống pattern `RoomService` test).
- Repository `findNotificationsList`: luôn gắn `recipientId`, dùng `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]`; khi truyền cả `category = 'FINANCE'` và `eventType = 'REPAIR_TICKET_CREATED'` (chéo nhóm) phải kết hợp bằng `AND` (hoặc trả về kết quả rỗng an toàn) thay vì ghi đè `where.eventType`.
- Service `getNotificationDetail` & `markAsRead`: khi Repository trả `null` → ném `ApiError(404, 'NOTIFICATION_NOT_FOUND')`.
- Service `getNotifications`: tính đúng `totalPages = total === 0 ? 0 : Math.ceil(total / query.limit)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/notifications/notification.repo-service.test.ts`  
Expected: FAIL (Cannot find module)

- [ ] **Step 3: Implement `notification.repository.ts` & `notification.service.ts`**

Lưu ý triển khai trong Repository:
- `findByIdAndMarkRead` và `markOneAsRead`: chạy trong `prisma.$transaction`, kiểm tra `findFirst({ where: { id: notificationId, recipientId } })`; nếu không có trả `null`. Nếu `isRead === false` → `updateMany({ where: { id: notificationId, recipientId, isRead: false }, data: { isRead: true } })` và cập nhật lại `isRead: true` trên object trả về, đồng thời đếm `unreadCount` mới trong cùng transaction.
- `markAllAsRead`: `updateMany({ where: { recipientId, isRead: false }, data: { isRead: true } })`, trả `{ updatedCount: result.count, unreadCount: 0 }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/notifications/notification.repo-service.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/notifications/notification.repository.ts src/modules/notifications/notification.service.ts tests/notifications/notification.repo-service.test.ts
git commit -m "feat(notifications): implement notification repository and service"
```

---

### Task 5: Controller, Routes, Mount `app.ts` & HTTP API Tests

**Files:**
- Create: `src/modules/notifications/notification.controller.ts`
- Create: `src/modules/notifications/notification.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/notifications/notification-api.test.ts`

**Interfaces:**
- Consumes: `requireActiveUser` (`src/common/middleware/require-role.ts`), `NotificationService`, validators.
- Produces: `notificationRouter` mounted in `src/app.ts` serving 5 endpoints.

- [ ] **Step 1: Write failing HTTP tests (`tests/notifications/notification-api.test.ts`)**

Test qua `http.createServer(app)` với stub `prisma.user.findUnique` và `NotificationService`:
- Không có Bearer token gọi `GET /api/v1/notifications` → `401 UNAUTHORIZED`.
- User bị khóa `accountStatus !== 'ACTIVE'` → `403 ACCOUNT_LOCKED`.
- `GET /api/v1/notifications/unread-count` → `200` `{ unreadCount }` (không bị `/:notificationId` nuốt).
- `PATCH /api/v1/notifications/read-all` → `200` `{ updatedCount, unreadCount: 0 }` (không bị `/:notificationId` nuốt).
- `GET /api/v1/notifications/not-a-uuid` → `400 VALIDATION_ERROR`.
- `GET /api/v1/notifications/<uuid>` khi không thuộc sở hữu → `404 NOTIFICATION_NOT_FOUND`.
- `PATCH /api/v1/notifications/<uuid>/read` → `200` trả object phẳng `{ id, eventType, category, title, content, actionUrl, relatedEntityType, relatedEntityId, payload, isRead: true, createdAt, unreadCount }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/notifications/notification-api.test.ts`  
Expected: FAIL (404 route not mounted / module not found)

- [ ] **Step 3: Implement `notification.controller.ts`, `notification.routes.ts`, and register in `src/app.ts`**

- Trong `notification.routes.ts`: dùng `requireActiveUser()` cho toàn bộ 5 route; đăng ký `/api/v1/notifications/unread-count` và `/api/v1/notifications/read-all` **trước** `/api/v1/notifications/:notificationId`.
- Trong `src/app.ts`: import `notificationRouter` và gọi `app.use(notificationRouter)` trước `errorHandler`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/notifications/notification-api.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/notifications/notification.controller.ts src/modules/notifications/notification.routes.ts src/app.ts tests/notifications/notification-api.test.ts
git commit -m "feat(notifications): add controller, routes, and mount notification router"
```

---

### Task 6: Tích hợp phát thông báo nguyên tử vào `viewing-appointments` (Phase 2)

**Files:**
- Modify: `src/modules/viewing-appointments/viewing-appointment.repository.ts`
- Modify: `src/modules/viewing-appointments/viewing-appointment.service.ts`
- Modify: `tests/viewing-appointment.repository.test.ts`
- Modify: `tests/viewing-appointment.service.test.ts`
- Modify: `tests/viewing-appointment-api.test.ts`

**Interfaces:**
- Consumes: `createNotification` (`src/common/utils/notification.util.ts`), `NOTIFICATION_EVENT_TYPE` (`src/common/constants/phase3-status.ts`).
- Produces: 4 sự kiện thông báo nguyên tử trong transaction cho `createAppointmentWithSlots`, `confirmAppointmentInTx`, `rejectAppointment`, `cancelAppointment`.

- [ ] **Step 1: Write failing tests for Viewing Appointment notification triggers & failure rollback safety**

Cập nhật `tests/viewing-appointment.repository.test.ts`, `tests/viewing-appointment.service.test.ts` & `tests/viewing-appointment-api.test.ts`:
- Cập nhật stub `prisma.$transaction` trong `viewing-appointment.repository.test.ts` và `viewing-appointment-api.test.ts` để giữ nguyên kịch bản conflict `409` khi `rejectAppointment` và `cancelAppointment` chạy trong `$transaction`.
- `createAppointmentWithSlots`: tạo notification `VIEWING_APPOINTMENT_CREATED` gửi tới `landlordId` với `actionUrl` & `relatedEntityType: 'VIEWING_APPOINTMENT'` (xử lý an toàn nếu `roomCode` / `property.name` vắng mặt trong mock).
- `confirmAppointmentInTx`: khi confirm thành công tạo notification `VIEWING_APPOINTMENT_CONFIRMED` gửi tới `tenantId`; khi `P2034` conflict không tạo notification.
- `rejectAppointment`: bọc trong `prisma.$transaction`, khi `count === 0` ném `409` và không tạo notification; khi thành công tạo `VIEWING_APPOINTMENT_REJECTED` gửi tới `tenantId` kèm lý do.
- `cancelAppointment`: bọc trong `prisma.$transaction`, khi Tenant hủy gửi `VIEWING_APPOINTMENT_CANCELLED` tới `landlordId`; khi Landlord hủy gửi tới `tenantId`; khi `count === 0` không tạo notification.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/viewing-appointment.repository.test.ts tests/viewing-appointment.service.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement notification hooks inside transactions in `viewing-appointment.repository.ts` & `viewing-appointment.service.ts`**

- Bổ sung `roomCode` và `property.name` vào `select` của `validateRoomPublicEligibility` để nội dung thông báo rõ mã phòng/khu trọ.
- Chuyển `rejectAppointment` và `cancelAppointment` sang `prisma.$transaction(async (tx) => ...)` — chỉ gọi `createNotification(tx, ...)` sau khi `updateMany` trả `count > 0`.
- Cập nhật `confirmAppointmentInTx` gọi `createNotification(tx, ...)` trước khi return.

- [ ] **Step 4: Run all Viewing Appointment tests to verify they pass**

Run: `npx tsx --test tests/viewing-appointment*.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/viewing-appointments/viewing-appointment.repository.ts src/modules/viewing-appointments/viewing-appointment.service.ts tests/viewing-appointment.repository.test.ts tests/viewing-appointment.service.test.ts
git commit -m "feat(viewing): emit atomic In-App notifications on create, confirm, reject, and cancel"
```

---

### Task 7: Live PostgreSQL Integration Tests & Full Regression Gate

**Files:**
- Create: `tests/notifications/notification-db.integration.test.ts`

- [ ] **Step 1: Write comprehensive Live PostgreSQL integration test (`tests/notifications/notification-db.integration.test.ts`)**

Kiểm tra trên DB PostgreSQL thật (skip nếu DB không chạy, dọn sạch dữ liệu ở `finally`):
- Tạo 2 user `TENANT` (tenantA, tenantB) và 1 `LANDLORD` + Property + Room.
- Tạo thông báo qua `createNotification` thuộc nhiều `category` khác nhau cho tenantA và tenantB.
- Xác minh `GET /api/v1/notifications`: chỉ trả thông báo của tenantA, lọc đúng theo `category`, `eventType`, `isRead`, cross-filter `category` + `eventType` chéo nhóm trả rỗng, phân trang chuẩn.
- Xác minh `GET /api/v1/notifications/unread-count` chính xác.
- Xác minh Anti-IDOR: tenantB gọi `GET /notifications/:id` hoặc `PATCH /notifications/:id/read` với ID của tenantA trả `404 NOTIFICATION_NOT_FOUND` và **không** làm đổi `isRead` của tenantA.
- Xác minh `GET /api/v1/notifications/:id` của tenantA tự chuyển `isRead: false → true` và giảm `unreadCount` đi 1; gọi lại lần 2 giữ nguyên `isRead: true` và `unreadCount`.
- Xác minh `PATCH /api/v1/notifications/read-all` đặt `unreadCount = 0` cho tenantA mà không ảnh hưởng thông báo chưa đọc của tenantB.
- Xác minh End-to-End `ViewingAppointment`: Tenant tạo lịch (`POST`) → Landlord nhận notification; Landlord xác nhận (`PATCH /confirm`) → Tenant nhận notification; Landlord/Tenant hủy/từ chối → bên kia nhận notification.

- [ ] **Step 2: Run full test suite & verification commands**

Run:
```powershell
npm run typecheck
npm run build
npm test
npm run db:check
git diff --check
```
Expected: Mọi lệnh thoát code `0`, 0 fail, `git diff --check` không có output lỗi.

- [ ] **Step 3: Commit**

```bash
git add tests/notifications/notification-db.integration.test.ts
git commit -m "test(notifications): add Live PostgreSQL integration tests for notifications and viewing hooks"
```
