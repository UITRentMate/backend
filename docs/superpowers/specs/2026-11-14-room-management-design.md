# Spec Thiết kế Kỹ thuật: [BE-P2-02] Quản lý phòng trọ, trạng thái hiển thị và chuẩn hóa Public API

- **Mã Issue:** GitHub Issue #15 (BE-P2-02)
- **Tác giả:** Phân hệ Điều phối Backend
- **Trạng thái:** Đã thống nhất thiết kế (Brainstormed & Approved)
- **Ngày lập:** 2026-11-14

---

## 1. Mục tiêu Nghiệp vụ

Chủ trọ sở hữu khu trọ quản lý toàn bộ vòng đời phòng trọ trực thuộc:
1. Tạo phòng mới với đầy đủ thông số tài chính, kỹ thuật, tiện ích và các khoản phí dịch vụ.
2. Quản lý danh sách và chi tiết phòng thuộc quyền sở hữu (xem được cả phòng đang hiển thị lẫn phòng đang ẩn).
3. Kiểm soát trạng thái vận hành có giới hạn: Chủ trọ chỉ được phép tự chuyển đổi qua lại giữa `VACANT ↔ MAINTENANCE`. Tuyệt đối cấm tự chuyển sang `HELD` hoặc `RENTED`.
4. Điều khiển trạng thái công khai (`visibilityStatus`): Chỉ cho phép bật hiển thị khi phòng thỏa mãn 5 điều kiện hiển thị của Phase 1.
5. Cập nhật thông tin phòng (Metadata, phí dịch vụ, tiện ích) qua endpoint `PUT`.
6. Chuẩn hóa URL xem chi tiết phòng công khai: URL chính thức `/api/v1/rooms/:roomId` và alias `/api/v1/public/rooms/:roomId` (đánh dấu deprecated). Đảm bảo route `/api/v1/rooms/search` luôn được đăng ký trước.

---

## 2. Mô hình Dữ liệu & Đề xuất Migration Cơ sở Dữ liệu

### 2.1. Ràng buộc mã phòng duy nhất theo khu trọ
Thêm ràng buộc `@@unique([propertyId, roomCode])` vào model `Room` trong `prisma/schema.prisma`:

```prisma
model Room {
  // ... các trường hiện tại giữ nguyên ...
  @@unique([propertyId, roomCode], map: "uq_rooms_property_room_code")
  @@map("rooms")
}
```

**Quy trình an toàn bắt buộc trước khi chạy Migration:**
1. Kiểm tra dữ liệu trùng lặp trong DB hiện có:
   ```sql
   SELECT property_id, room_code, COUNT(*) 
   FROM rooms 
   GROUP BY property_id, room_code 
   HAVING COUNT(*) > 1;
   ```
2. Nếu phát hiện dữ liệu trùng: Orchestrator báo cáo danh sách và đề xuất giải pháp đổi hậu tố (ví dụ: đổi mã trùng thứ hai thành `<code-gốc>-DUP`), không bao giờ tự ý xóa dữ liệu.
3. Sau khi người dùng xác nhận dữ liệu đã sạch, Orchestrator trình migration diff và chờ lệnh phê duyệt trước khi chạy `prisma migrate dev`.

### 2.2. Giá trị mặc định khi tạo phòng
- `occupancyStatus = 'VACANT'`
- `visibilityStatus = 'HIDDEN'`
- `isArchived = false`

### 2.3. Cơ chế cập nhật phòng qua PUT (ROOM-04)
- **Full Replace trong Database Transaction:** Đối với danh sách `RoomAmenity` và `RoomServiceFee`, hệ thống xóa toàn bộ các liên kết cũ của phòng và tạo mới theo payload của `PUT`, đảm bảo tính toàn vẹn và ngữ nghĩa idempotent chuẩn RESTful.

---

## 3. Quy tắc State Machine & Lifecycle

### 3.1. Trạng thái vận hành (`occupancyStatus`)
- Chủ trọ chỉ được phép chuyển đổi: **`VACANT ↔ MAINTENANCE`**.
- Chuyển `VACANT` $\rightarrow$ `MAINTENANCE`: 
  - Điều kiện chặn cứng: Cấm chuyển sang bảo trì nếu phòng đang có `Contract` hiệu lực (`status IN ('ACTIVE', 'PENDING')`) HOẶC có `RentalRequest` đang xử lý (`status IN ('PENDING', 'ACCEPTED')`). (Lịch xem phòng `ViewingAppointment` không chặn cứng).
  - Side-effect: **Tự động chuyển `visibilityStatus` về `HIDDEN`**.
- Chuyển `MAINTENANCE` $\rightarrow$ `VACANT`: Cho phép khi hoàn tất bảo trì. Giữ nguyên `visibilityStatus = 'HIDDEN'`.
- Chuyển sang `HELD` hoặc `RENTED`: Hệ thống từ chối ngay lập tức với lỗi `409 Conflict`.

### 3.2. Trạng thái hiển thị (`visibilityStatus`)
- `HIDDEN`: Chủ trọ có thể tắt bất cứ lúc nào.
- `VISIBLE`: Bắt buộc thỏa mãn 5 điều kiện:
  1. `Room.occupancyStatus === 'VACANT'` (nếu khác trả `409 Conflict`).
  2. `Room.isArchived === false`.
  3. `Property.status === 'ACTIVE'`.
  4. `Landlord.accountStatus === 'ACTIVE'`.
  5. Không bị Admin áp đặt khóa hiển thị.

---

## 4. Danh sách Endpoints & API Contract

| STT | Phương thức | Đường dẫn Endpoint | Phân quyền | Chức năng | Chi tiết Phản hồi / Xử lý |
|---|---|---|---|---|---|
| 1 | POST | `/api/v1/landlord/properties/:propertyId/rooms` | Landlord sở hữu | Tạo phòng trọ mới kèm tiện ích & phí | 201 Created |
| 2 | GET | `/api/v1/landlord/properties/:propertyId/rooms` | Landlord sở hữu | Danh sách phòng quản lý (phân trang & lọc) | 200 OK: Trả về items phân trang + block `summary: { total, vacant, maintenance, rented, held, visible, hidden }` |
| 3 | GET | `/api/v1/landlord/rooms/:roomId` | Landlord sở hữu | Chi tiết toàn diện phòng quản lý | 200 OK |
| 4 | PUT | `/api/v1/landlord/rooms/:roomId` | Landlord sở hữu | Cập nhật thông tin phòng, tiện ích & phí | 200 OK: Full replace RoomAmenity & RoomServiceFee trong transaction |
| 5 | PATCH | `/api/v1/landlord/rooms/:roomId/operational-status` | Landlord sở hữu | Chuyển đổi trạng thái `VACANT ↔ MAINTENANCE` | 200 OK: Kiểm tra Contract/RentalRequest, tự động ẩn phòng khi bảo trì |
| 6 | PATCH | `/api/v1/landlord/rooms/:roomId/visibility` | Landlord sở hữu | Bật/Tắt hiển thị phòng | 200 OK: Ràng buộc 5 điều kiện Phase 1 |
| 7 | GET | `/api/v1/rooms/:roomId` | Public | URL chính thức xem chi tiết phòng công khai | 200 OK: Handler `RoomController.getPublicRoomDetail` |
| 8 | GET | `/api/v1/public/rooms/:roomId` | Public | Alias xem chi tiết phòng (deprecated) | 200 OK: Cùng handler với URL chính thức, đính kèm header `Deprecation: @true` |
| 9 | GET | `/api/v1/rooms/search` | Public | Tìm kiếm phòng Phase 1 (giữ nguyên, đăng ký trước) | 200 OK |

---

## 5. Kiến trúc Module (`src/modules/rooms/`)

Áp dụng **Hướng tiếp cận 1** (Sub-controller & Sub-service):
- `room.routes.ts`: Đăng ký router công khai và router quản lý của chủ trọ (bọc bởi `requireAuth`).
- `room-management.controller.ts`: Tiếp nhận HTTP requests từ chủ trọ, validate dữ liệu, gọi Service, trả response.
- `room-management.service.ts`: Xử lý toàn bộ business logic, kiểm tra quyền sở hữu, state machine, gọi Repository (không import Prisma Client trực tiếp).
- `room-management.repository.ts`: Đóng gói các câu lệnh Prisma Client và Database Transactions.
- `room-management.validation.ts`: Zod schemas cho Create/Update room, Visibility, Operational Status.
- `room-management.types.ts`: TypeScript DTOs cho các request/response quản lý.

---

## 6. Chiến lược Kiểm thử (Testing)

- `tests/room-management.test.ts`:
  - Unit tests cho State Machine validation (`VACANT ↔ MAINTENANCE`, từ chối `HELD/RENTED`).
  - Unit tests cho Visibility policy (5 điều kiện bắt buộc).
  - Unit tests đảm bảo Service không import Prisma trực tiếp (tuân thủ kiến trúc phân tầng).
  - API Integration tests cho đầy đủ 8 endpoints mới + 1 route chuẩn hóa.
