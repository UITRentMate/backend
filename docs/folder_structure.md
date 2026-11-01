# Cấu Trúc Thư Mục & Phân Tầng Kiến Trúc (Backend)

Tài liệu này giải thích chi tiết kiến trúc **Modular Monolith kết hợp Lightweight Layered Architecture** của **RentMate Backend**, làm cơ sở cho đội ngũ phát triển mở rộng các tính năng nghiệp vụ một cách nhất quán và dễ bảo trì.

---

## 1. Cấu trúc thư mục hiện tại (Thực tế Base Project)

Hiện tại, mã nguồn Backend sau giai đoạn khởi tạo có cấu trúc cây thư mục như sau:

```
backend/
├── prisma/
│   ├── migrations/
│   │   ├── 20261030052416_init_schema/
│   │   │   └── migration.sql       # File DDL SQL Initial Migration (32 bảng)
│   │   └── migration_lock.toml     # File khóa phiên bản động cơ Prisma
│   └── schema.prisma               # Định nghĩa 32 models, 59 quan hệ và ràng buộc CSDL
├── src/
│   ├── common/
│   │   └── .gitkeep                # Thành phần dùng chung (middlewares, errors, utils...)
│   ├── config/
│   │   └── env.ts                  # Cấu hình nạp và kiểm tra biến môi trường
│   ├── infrastructure/
│   │   └── database/
│   │       ├── check-connection.ts # Script kiểm tra kết nối PostgreSQL SELECT 1
│   │       └── prisma.ts           # Khởi tạo thể hiện PrismaClient singleton chung
│   ├── modules/
│   │   └── .gitkeep                # Thư mục gốc chứa các module nghiệp vụ
│   ├── app.ts                      # Cấu hình Express app và gắn kết middleware
│   └── server.ts                   # Điểm nhập chạy máy chủ và lắng nghe cổng HTTP
├── tests/
│   └── .gitkeep                    # Thư mục chuẩn bị cho kiểm thử tự động
├── .env.example                    # File mẫu biến môi trường
├── .gitignore                      # Loại trừ node_modules, dist, .env khỏi Git
├── package.json                    # Khai báo dependencies và scripts
├── package-lock.json               # Khóa phiên bản dependency chính xác
└── tsconfig.json                   # Cấu hình TypeScript (CommonJS target)
```

> **Lưu ý:** Các file `.gitkeep` giúp Git nhận diện các thư mục rỗng trong giai đoạn khởi tạo. Khi tạo các file mã nguồn thực tế, các file `.gitkeep` có thể được giữ lại hoặc xóa bỏ mà không ảnh hưởng.

---

## 2. Trách nhiệm của từng thư mục

### 2.1. Thư mục `src/config/`
- **Mục đích:** Quản lý toàn bộ cấu hình và nạp biến môi trường cho máy chủ.
- **Hiện tại:** [src/config/env.ts](../src/config/env.ts) sử dụng tính năng `process.loadEnvFile()` của Node.js 24 để nạp file `.env` một cách an toàn và export các hằng số: `PORT`, `DATABASE_URL`.

### 2.2. Thư mục `src/infrastructure/`
- **Mục đích:** Đóng gói các kết nối kỹ thuật tới hạ tầng bên ngoài (Cơ sở dữ liệu, dịch vụ lưu trữ file, mailer...).
- **Hiện tại:**
  - `database/prisma.ts`: Khởi tạo duy nhất một thể hiện `PrismaClient` singleton để dùng chung toàn ứng dụng.
  - `database/check-connection.ts`: Script hỗ trợ kiểm tra kết nối CSDL và tự động che giấu mật khẩu trong log lỗi.

### 2.3. Thư mục `src/common/`
- **Mục đích:** Chứa các thành phần dùng chung xuyên suốt mọi module trong Backend.
- **Cấu trúc dự kiến khi bước vào phát triển nghiệp vụ:**
  ```
  src/common/
  ├── middlewares/         # Middleware xác thực (auth.guard), kiểm tra quyền (role.guard), xử lý lỗi tập trung (error.handler)
  ├── errors/              # Custom Error classes (AppError, NotFoundError, BadRequestError, ForbiddenError)
  ├── constants/           # Các hằng số dùng chung, thông báo lỗi chuẩn
  └── utils/               # Hàm tiện ích thuần túy (format, hash helper, date calculation)
  ```

### 2.4. Thư mục `src/modules/` (Trọng tâm nghiệp vụ)
- **Mục đích:** Chứa toàn bộ các module chức năng nghiệp vụ của hệ thống theo mô hình Modular Monolith.
- **Cấu trúc dự kiến của một module chuẩn:**
  Mỗi module đại diện cho một miền nghiệp vụ (ví dụ `auth`, `properties`, `rooms`, `appointments`, `contracts`, `invoices`, `roommates`, `complaints`...):
  ```
  src/modules/rooms/
  ├── rooms.routes.ts          # Định nghĩa endpoint Express (GET /api/rooms, POST /api/rooms...)
  ├── rooms.controller.ts      # Tiếp nhận HTTP request, validate tham số, gọi service và trả response
  ├── rooms.service.ts         # Xử lý Business Logic, kiểm tra luật nghiệp vụ, gọi Prisma
  ├── rooms.repository.ts      # (Tùy chọn) Chỉ tạo khi cần câu truy vấn SQL thô hoặc filter phức tạp
  └── dto/ hoặc types/         # Khai báo kiểu request body, query params và response schema
  ```

### 2.5. Thư mục `prisma/`
- **Mục đích:** Quản lý toàn bộ cấu trúc dữ liệu và lịch sử tiến hóa của PostgreSQL.
- **Nội dung:**
  - `schema.prisma`: Khai báo 32 thực thể ERD, các kiểu dữ liệu, quan hệ khóa ngoại và quy tắc xóa (`ON DELETE RESTRICT`).
  - `migrations/`: Lưu trữ các file SQL migration đã được áp dụng và xác minh.

### 2.6. Thư mục `tests/`
- **Mục đích:** Chứa các kịch bản kiểm thử tự động (Unit Test, Integration Test cho API) ở các phase tiếp theo.

---

## 3. Quy chuẩn phân tầng Lightweight Layered Architecture

Hệ thống áp dụng mô hình phân tầng nhẹ nhằm giữ code tinh gọn và tránh over-engineering:

```
[Client Request]
       │
       ▼
[Router] (modules/*.routes.ts)
  - Định nghĩa đường dẫn và HTTP method.
  - Gắn các middleware kiểm tra quyền (Auth Guard, Role Check).
       │
       ▼
[Controller] (modules/*.controller.ts)
  - Đọc request (body, query, params).
  - Kiểm tra tính hợp lệ cơ bản của dữ liệu (validation).
  - Gọi Service tương ứng để thực hiện nghiệp vụ.
  - Trả về mã HTTP status (200, 201, 400, 404...) và dữ liệu JSON.
  - Tuyệt đối KHÔNG viết Business Logic hoặc truy vấn database tại Controller.
       │
       ▼
[Service] (modules/*.service.ts)
  - Chứa TOÀN BỘ Business Logic và quy tắc nghiệp vụ của Use Case.
  - Kiểm tra điều kiện (ví dụ: phòng đã được thuê chưa, cọc có đủ không).
  - Quản lý Database Transaction khi một hành động cần ghi nhiều bảng.
  - Gọi trực tiếp Prisma Client (hoặc Repository nếu có).
       │
       ▼
[Prisma Client / Database] (src/infrastructure/database/prisma.ts)
  - Thực thi truy vấn với PostgreSQL và trả dữ liệu về Service.
```

> [!NOTE]
> **Về Repository Layer:**
> Trong mô hình này, **Repository Layer KHÔNG phải là lớp bắt buộc cho mọi module**. Với các thao tác truy vấn CRUD thông thường, Service được phép gọi trực tiếp `prisma.<model>.<action>()` để code ngắn gọn, rõ ràng. Repository chỉ nên tạo khi có các truy vấn SQL thô (`$queryRaw`) hoặc biểu thức lọc quá phức tạp cần được tái sử dụng ở nhiều nơi.

---

## 4. Hướng dẫn bổ sung một Module mới

Khi bắt đầu xây dựng một Use Case hoặc chức năng mới (ví dụ module quản lý phòng trọ: `rooms`):

1. Tạo thư mục `src/modules/rooms/`.
2. Tạo file định kiểu đầu vào `src/modules/rooms/dto/create-room.dto.ts`.
3. Tạo file `src/modules/rooms/rooms.service.ts` triển khai các phương thức nghiệp vụ (`createRoom`, `getRoomsByLandlord`...).
4. Tạo file `src/modules/rooms/rooms.controller.ts` xử lý tiếp nhận request và gọi Service.
5. Tạo file `src/modules/rooms/rooms.routes.ts` khai báo các router endpoint.
6. Đăng ký router mới vào ứng dụng Express tại file [src/app.ts](../src/app.ts) (ví dụ: `app.use('/api/rooms', roomRoutes);`).

---

## 5. Quy tắc Import & Tránh phụ thuộc vòng (Circular Dependencies)

Để giữ Backend chạy ổn định trên nền tảng CommonJS và tránh lỗi tham chiếu vòng (`undefined` lúc runtime):

1. **Chiều phụ thuộc phân tầng (Strict Top-Down Dependency):**
   ```
   src/server.ts ──► src/app.ts ──► src/modules/ ──► src/common/ & src/infrastructure/
   ```
   - `server.ts` import `app.ts`.
   - `app.ts` import các `routes` từ `modules/`.
   - `routes` import `controller`.
   - `controller` import `service`.
   - `service` import `prisma` từ `infrastructure/database/prisma.ts`.
   - Tầng dưới tuyệt đối **không import ngược** lên tầng trên.
2. **Quy tắc giữa các Modules:**
   - Hạn chế tối đa việc Module A import Service của Module B.
   - Nếu hai module cần chia sẻ logic chung (ví dụ tạo thông báo, ghi audit log), hãy đặt logic đó vào `common/` hoặc gọi thông qua một Shared Service được thiết kế riêng.
