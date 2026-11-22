# Technical Design Specification: In-App Notifications Subsystem (BE-P3-07)

**Issue:** #36 (`[BE-P3-07] Quản lý Thông báo In-App`)  
**Tác giả:** Phan Gia Đạt (`@phangiadat`)  
**Ngày:** 2026-11-22  
**Nhánh:** `feat/be-p3-07-notifications-api`  
**Trạng thái:** ĐÃ CHỐT THIẾT KẾ (Approved in Brainstorming)

---

## 1. Mục tiêu nghiệp vụ (Business Goals)

Xây dựng phân hệ Quản lý Thông báo In-App (`src/modules/notifications/`) và chuẩn hóa hợp đồng phát thông báo dùng chung cho toàn bộ hệ thống RentMate Backend:
1. **Truy vấn & Quản lý trạng thái đọc thông báo (UC-27, API-15):** Cho phép người dùng `ACTIVE` xem danh sách thông báo của chính mình (phân trang, lọc theo `category`, `eventType`, `isRead`), lấy nhanh số thông báo chưa đọc (`unreadCount`), mở chi tiết (tự động chuyển `isRead = true`), đánh dấu đọc 1 thông báo (idempotent), và đánh dấu tất cả đã đọc.
2. **Chuẩn hóa hợp đồng sự kiện & Payload cho cả team (BE-A, BE-B, BE-C):** Chuẩn hóa `NOTIFICATION_CATEGORY`, `NOTIFICATION_EVENT_TYPE` (tối đa 40 ký tự theo cột `notifications.event_type`) và typed `NotificationPayload` (`content`, `actionUrl`, `relatedEntityType`, `relatedEntityId`, `metadata`) trong `phase3-status.ts` & `notification.util.ts`.
3. **Tích hợp nguồn phát Viewing Appointments (Phase 2):** Ghi nhận thông báo nguyên tử trong cùng transaction khi tạo, xác nhận, từ chối và hủy lịch hẹn xem phòng. (Phân hệ `rental-requests/` phối hợp giao cho `@jack1e2401` trong Issue #33 để tránh xung đột mã nguồn).

---

## 2. Ranh giới kiến trúc & Nguyên tắc cốt lõi

1. **Zero DB Schema Drift:** Không sửa `prisma/schema.prisma`, không tạo migration mới. Dùng nguyên bảng `notifications` (`id`, `recipientId`, `title`, `eventType`, `payload`, `isRead`, `createdAt`) và index `notifications_recipient_id_is_read_created_at_idx`.
2. **REST API + Polling (Chưa dùng WebSocket/SSE ở Phase 3):** Frontend sử dụng REST + polling nhẹ trên `GET /api/v1/notifications/unread-count`. `createNotification` đóng gói gọn ở tầng utility để có thể gắn thêm emitter nếu nâng cấp real-time ở phase sau.
3. **Layered Modular Monolith:** Tuân thủ tuyệt đối `Routes → Controller → Service → Repository → Prisma Singleton → PostgreSQL`. Service không được import Prisma Client trực tiếp.
4. **Anti-Enumeration / Anti-IDOR:** Mọi truy vấn đọc/cập nhật theo `notificationId` đều lọc theo `recipientId = currentUser.id`. Khi bản ghi không tồn tại hoặc thuộc user khác, bắt buộc trả `404 NOTIFICATION_NOT_FOUND`.
5. **Express 5 Route Ordering:** Các route tĩnh `/api/v1/notifications/unread-count` và `/api/v1/notifications/read-all` phải đăng ký trước route tham số `/api/v1/notifications/:notificationId`.

---

## 3. Thiết kế Hợp đồng Dùng chung (`phase3-status.ts` & `notification.util.ts`)

### 3.1. Danh mục (`NOTIFICATION_CATEGORY`) & Ánh xạ từ `eventType`
- `BOOKING_CONTRACT`: `VIEWING_APPOINTMENT_*`, `RENTAL_REQUEST_*`, `CONTRACT_*`, `RESIDENT_*`
- `FINANCE`: `DEPOSIT_*` *(và mở rộng cho `INVOICE_*`, `PAYMENT_*` ở Phase 4)*
- `REPAIR`: `REPAIR_TICKET_*`
- `SYSTEM`: `LANDLORD_VERIFICATION_*` *(và fallback mặc định cho mọi `eventType` chưa khai báo)*

Bổ sung các `NOTIFICATION_EVENT_TYPE` mới (đều `<= 29` ký tự, khớp `VARCHAR(40)`):
- `VIEWING_APPOINTMENT_CREATED`
- `VIEWING_APPOINTMENT_CONFIRMED`
- `VIEWING_APPOINTMENT_REJECTED`
- `VIEWING_APPOINTMENT_CANCELLED`
- `RENTAL_REQUEST_CREATED`
- `RENTAL_REQUEST_REJECTED`

### 3.2. Typed `NotificationPayload` (`src/common/utils/notification.util.ts`)
```typescript
export interface NotificationPayload {
  content?: string;
  actionUrl?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  metadata?: Record<string, unknown>;
}
```
Hàm `createNotification` và `createNotificationsBatch` nhận `payload?: NotificationPayload | Prisma.InputJsonValue | null` (giữ tương thích ngược 100%) và đảm bảo `title` được cắt/chuẩn hóa an toàn trong giới hạn `200` ký tự của `VARCHAR(200)`.

---

## 4. Đặc tả Endpoints & DTOs (`src/modules/notifications/`)

| Method | Endpoint | Auth | Response |
|---|---|---|---|
| `GET` | `/api/v1/notifications` | `requireActiveUser` | `200 OK`: `{ items, total, page, limit, totalPages, unreadCount }` |
| `GET` | `/api/v1/notifications/unread-count` | `requireActiveUser` | `200 OK`: `{ unreadCount }` |
| `PATCH` | `/api/v1/notifications/read-all` | `requireActiveUser` | `200 OK`: `{ updatedCount, unreadCount: 0 }` |
| `GET` | `/api/v1/notifications/:notificationId` | `requireActiveUser` | `200 OK`: `{ ...NotificationItemDTO, unreadCount }` (object phẳng, tự set `isRead = true` nếu đang `false`) |
| `PATCH` | `/api/v1/notifications/:notificationId/read` | `requireActiveUser` | `200 OK`: `{ ...NotificationItemDTO, unreadCount }` (object phẳng, idempotent) |

### Query Params cho `GET /api/v1/notifications`
- `page`: số nguyên `>= 1` (mặc định `1`)
- `limit` (hoặc alias `pageSize`): số nguyên `1..50` (mặc định `20`; nếu truyền cả hai thì ưu tiên `limit`)
- `isRead`: `'true' | 'false'` (tùy chọn)
- `category`: `'BOOKING_CONTRACT' | 'FINANCE' | 'REPAIR' | 'SYSTEM'` (tùy chọn)
- `eventType`: chuỗi khớp `^[A-Z0-9_]{1,40}$` (tùy chọn, tương thích xuôi với các sự kiện Phase 4+)

### Shape chuẩn của `NotificationItemDTO`
```typescript
export interface NotificationItemDTO {
  id: string;
  eventType: string;
  category: NotificationCategory;
  title: string;
  content: string | null;
  actionUrl: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  payload: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
}
```

---

## 5. Tích hợp `src/modules/viewing-appointments/`

Ghi `createNotification(tx, ...)` nguyên tử trong transaction tại 4 luồng:
1. `createAppointmentWithSlots`: gửi tới `property.landlordId` (`VIEWING_APPOINTMENT_CREATED`, `actionUrl: /landlord/viewing-appointments/${appointment.id}`).
2. `confirmAppointmentInTx`: gửi tới `appointment.tenantId` (`VIEWING_APPOINTMENT_CONFIRMED`, `actionUrl: /viewing-appointments/${appointment.id}`).
3. `rejectAppointment` (bọc `$transaction` kiểm tra `updateMany` `count > 0` trước khi tạo notification): gửi tới `appointment.tenantId` (`VIEWING_APPOINTMENT_REJECTED`, kèm `reason`).
4. `cancelAppointment` (bọc `$transaction`): nếu người hủy là Tenant → gửi tới `landlordId`; nếu là Landlord → gửi tới `tenantId` (`VIEWING_APPOINTMENT_CANCELLED`, kèm `reason`).
