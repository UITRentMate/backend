# RentMate — Backend

Hệ thống quản lý và cho thuê phòng trọ thông minh — Phân hệ Dịch vụ Máy chủ & Cơ sở dữ liệu (Backend API Service).

---

## 1. Giới thiệu dự án

**RentMate Backend** cung cấp hệ thống API máy chủ, xử lý nghiệp vụ, kiểm soát giao dịch tài chính, quản lý dữ liệu cư trú, công tơ điện nước và nhật ký hệ thống cho toàn bộ nền tảng RentMate.

- **Môn học:** SE100 — Phát triển phần mềm hướng đối tượng
- **Đơn vị:** Trường Đại học Công nghệ Thông tin (UIT) — ĐHQG TP.HCM
- **Nhóm thực hiện:** Nhóm 15 (5 thành viên: 3 Frontend, 2 Backend)
- **Thời hạn dự kiến hoàn thành đồ án:** 27/12/2026
- **Trạng thái hiện tại:** Nhánh `feat/auth` đã bổ sung API đăng ký, đăng nhập, làm mới token, đăng xuất và xem tài khoản cùng migration bảng phiên refresh. Cần áp dụng migration trên PostgreSQL và FE 1 review contract trước khi tích hợp.
- **Tình trạng API Contract:** Authentication/User đang chờ FE 1 xác nhận; xem [đề xuất cho issue #7](docs/issues/7-auth-user-endpoint-proposal.md).

---

## 2. Công nghệ sử dụng (Tech Stack)

Mã nguồn Backend được xây dựng dựa trên các công nghệ thực tế sau:

| Thành phần | Công nghệ / Thư viện | Phiên bản thực tế | Ghi chú |
| :--- | :--- | :---: | :--- |
| **Nền tảng máy chủ** | [Node.js](https://nodejs.org/) | `>= 24.x` | JavaScript runtime với tính năng `process.loadEnvFile()` |
| **Web Framework** | [Express](https://expressjs.com/) | `^5.3.0` | Framework xây dựng RESTful API thế hệ mới |
| **Ngôn ngữ** | [TypeScript](https://www.typescriptlang.org/) | `~5.8.0` | Định kiểu tĩnh với hệ thống module CommonJS |
| **ORM / Data Access** | [Prisma ORM](https://www.prisma.io/) | `6.19.3` | Quản lý schema, migrations và truy vấn dữ liệu |
| **Cơ sở dữ liệu** | [PostgreSQL](https://www.postgresql.org/) | `18.x` (hỗ trợ 16 - 18) | CSDL quan hệ lưu trữ chính (`rentmate_dev`) |
| **Dev Execution** | [tsx](https://github.com/privatenumber/tsx) | `^4.23.15` | Trình chạy TypeScript tức thì với tính năng file watcher |
| **Xác thực** | bcrypt, jsonwebtoken | Xem `package-lock.json` | Băm mật khẩu, ký JWT access token |

---

## 3. Yêu cầu môi trường & Cài đặt

### 3.1. Điều kiện tiên quyết
- **Node.js:** Phiên bản `>= 24.0.0` (khuyến nghị Node.js v24.x LTS).
- **PostgreSQL:** Phiên bản `16.x` đến `18.x` đã được cài đặt và đang chạy dịch vụ cục bộ trên máy.
- **npm:** Phiên bản `>= 10.0.0`.

### 3.2. Cài đặt dependencies
Mở terminal tại thư mục `backend/` và thực hiện:

- **Khuyến nghị (Clean Install):** Sử dụng `npm ci` để cài đặt phiên bản đồng nhất và chuẩn xác 100% theo file [package-lock.json](package-lock.json):
  ```bash
  npm ci
  ```
- **Tùy chọn:** Sử dụng `npm install` khi cần cập nhật hoặc bổ sung các package mới theo quy trình đã thống nhất:
  ```bash
  npm install
  ```

---

## 4. Hướng dẫn thiết lập môi trường cho thành viên mới (Setup Guide)

Quy trình tuần tự từng bước để một thành viên mới clone repository và khởi chạy Backend hoàn chỉnh trên máy cục bộ:

### Bước 1: Cài đặt thư viện
```bash
npm ci
```

### Bước 2: Cấu hình biến môi trường (.env) và Tạo Database development
1. Tạo bản sao từ file mẫu [.env.example](.env.example):
   ```bash
   cp .env.example .env
   # Hoặc trên Windows PowerShell:
   Copy-Item .env.example .env
   ```
2. Mở file `.env` và điền cấu hình PostgreSQL thực tế trên máy của bạn:
   ```env
   PORT=5000
   DATABASE_URL="postgresql://postgres:mat_khau_cua_ban@localhost:5432/rentmate_dev?schema=public"
   JWT_SECRET="REPLACE_ME"
   CORS_ORIGINS="http://localhost:3000,http://localhost:5173"
   ```
   Thay `REPLACE_ME` bằng chuỗi ngẫu nhiên bí mật dài ít nhất 32 ký tự trước khi chạy API xác thực. Cập nhật `CORS_ORIGINS` theo origin chính xác của Frontend, phân cách nhiều origin bằng dấu phẩy.
3. Mở pgAdmin 4 hoặc `psql`, tạo một database trống tên là **`rentmate_dev`**:
   ```sql
   CREATE DATABASE rentmate_dev;
   ```

> [!CAUTION]
> **Quy tắc bảo mật nghiêm ngặt:** File `.env` chứa mật khẩu CSDL cá nhân và đã được đưa vào [.gitignore](.gitignore). **Tuyệt đối không đưa file `.env` hoặc bất kỳ mật khẩu nào vào các commit trên Git.**

### Bước 3: Sinh Prisma Client
Sinh bộ types và phương thức truy vấn cho Prisma Client v6.19.3 từ [prisma/schema.prisma](prisma/schema.prisma):
```bash
npx prisma generate
```

### Bước 4: Áp dụng Migration đã có vào CSDL
Đồng bộ cấu trúc 32 bảng nghiệp vụ từ thư mục `prisma/migrations/20261030052416_init_schema/` vào `rentmate_dev`:
```bash
npx prisma migrate deploy
```

> [!WARNING]
> **Quy định an toàn Migration:**
> - Sử dụng lệnh **`npx prisma migrate deploy`** để áp dụng migration đã qua kiểm duyệt một cách an toàn.
> - **Tuyệt đối KHÔNG** chạy các lệnh phá hủy như `npx prisma db push` hoặc `npx prisma migrate reset`.
> - Không tự ý sửa đổi file [prisma/schema.prisma](prisma/schema.prisma) hoặc tạo migration mới khi chưa có kế hoạch được phê duyệt.

Nhánh `feat/auth` bổ sung migration `20261105000000_refresh_sessions` cho refresh token. Dùng `migrate deploy` sau khi tạo database để áp dụng cả initial migration và migration này.

### Bước 5: Kiểm tra kết nối CSDL
Kiểm tra kết nối an toàn từ Backend tới cơ sở dữ liệu `rentmate_dev` (truy vấn `SELECT 1`, không đổi dữ liệu):
```bash
npm run db:check
```
*Khi kết nối thành công, script sẽ hiển thị: `✓ Kết nối PostgreSQL thành công! (Thao tác: SELECT 1 - OK)`.*

### Bước 6: Khởi chạy máy chủ phát triển
```bash
npm run dev
```
Máy chủ sẽ khởi chạy tại `http://localhost:5000`. Bạn có thể truy cập `http://localhost:5000/health` để kiểm tra máy chủ đã sẵn sàng.

---

## 5. Các lệnh chạy dự án (Scripts)

Các lệnh phát triển được định nghĩa trong [package.json](package.json):

| Lệnh | Cú pháp | Mục đích |
| :--- | :--- | :--- |
| **Chạy Development Server** | `npm run dev` | Khởi chạy máy chủ Express với hot-reload qua `tsx watch src/server.ts` tại cổng cấu hình (mặc định 5000). |
| **Kiểm tra TypeScript (Typecheck)** | `npm run typecheck` | Chạy `tsc --noEmit` kiểm tra toàn bộ kiểu dữ liệu mà không sinh file JavaScript. |
| **Biên dịch Production (Build)** | `npm run build` | Chạy trình biên dịch TypeScript (`tsc`) để xuất mã nguồn JavaScript sang thư mục `dist/`. |
| **Chạy Production Server** | `npm start` | Chạy máy chủ từ mã nguồn đã biên dịch tại `dist/server.js`. |
| **Kiểm tra kết nối Database** | `npm run db:check` | Thực thi truy vấn `SELECT 1` bằng Prisma Client để xác minh trạng thái kết nối tới PostgreSQL. |
| **Kiểm thử API** | `npm test` | Chạy test cho các luồng xác thực và lỗi quan trọng. |

---

## 6. Chi tiết Endpoint `/health`

Hệ thống cung cấp sẵn một endpoint kiểm tra trạng thái hoạt động:

- **URL:** `GET http://localhost:5000/health`
- **Mã phản hồi HTTP:** `200 OK`
- **Dữ liệu trả về (JSON):**
  ```json
  {
    "status": "ok",
    "service": "rentmate-backend"
  }
  ```
- **Mục đích:** Phục vụ kiểm tra tình trạng sống cơ bản (Liveness / Basic HTTP Health Check) của máy chủ Express mà không yêu cầu xác thực hoặc truy vấn cơ sở dữ liệu. *(Lưu ý: Endpoint này không đóng vai trò Database Readiness Check vì hiện chưa kiểm tra kết nối tới PostgreSQL).*

---

## 7. Authentication & User API trên `feat/auth`

| Method | Endpoint | Chức năng |
| :--- | :--- | :--- |
| `POST` | `/api/v1/auth/register` | Tạo tài khoản `TENANT`/`ACTIVE`. |
| `POST` | `/api/v1/auth/login` | Đăng nhập bằng email hoặc số điện thoại; JSON trả JWT access token hạn 1 giờ. |
| `POST` | `/api/v1/auth/refresh` | Dùng refresh token trong HttpOnly Cookie để xoay vòng token và cấp JWT mới. |
| `POST` | `/api/v1/auth/logout` | Thu hồi refresh session hiện tại và xóa cookie. |
| `GET` | `/api/v1/users/me` | Xem tài khoản hiện tại với `Authorization: Bearer <accessToken>`. |

Refresh token chỉ nằm trong HttpOnly Cookie và được lưu dạng hash trong PostgreSQL. Phiên hết hạn sau 7 ngày tính từ lần đăng nhập; refresh không kéo dài hạn này. Access token đã cấp vẫn có hiệu lực tới khi hết hạn, tối đa 1 giờ sau logout. Backend chỉ trả CORS headers cho origin có trong `CORS_ORIGINS` và cho phép credentials; các request Frontend cần gửi/nhận cookie (login, refresh, logout) phải dùng `credentials: 'include'`. Cookie dùng `SameSite=Lax`, nên Frontend và Backend cần cùng site (ví dụ hai cổng localhost khi phát triển).

---

## 8. Cấu trúc thư mục mã nguồn

Backend áp dụng kiến trúc **Modular Monolith kết hợp Lightweight Layered Architecture**:

```
backend/
├── prisma/
│   ├── migrations/         # Lịch sử các migration đã được kiểm toán
│   │   └── 20261030052416_init_schema/
│   └── schema.prisma       # Định nghĩa 32 models, 59 quan hệ và ràng buộc CSDL
├── src/
│   ├── common/             # Thành phần dùng chung (middlewares, errors, constants...)
│   ├── config/             # Nạp và quản lý biến môi trường an toàn (`env.ts`)
│   ├── infrastructure/     # Kết nối hạ tầng ngoài, cơ sở dữ liệu (`prisma.ts`, `check-connection.ts`)
│   ├── modules/            # Các module chức năng nghiệp vụ tự đóng gói
│   ├── app.ts              # Khởi tạo và cấu hình ứng dụng Express
│   └── server.ts           # Điểm nhập chạy máy chủ và lắng nghe cổng HTTP
├── tests/                  # Thư mục dành cho kiểm thử tự động
├── .env.example            # Mẫu cấu hình môi trường chuẩn
├── .gitignore              # Danh sách các file bị loại trừ khỏi Git
├── package.json            # Khai báo dependencies và scripts
└── tsconfig.json           # Cấu hình biên dịch TypeScript (CommonJS)
```

> Chi tiết phân tầng kiến trúc, luồng dữ liệu và hướng dẫn mở rộng module xem tại: [docs/folder_structure.md](docs/folder_structure.md).

---

## 9. Quy tắc đóng góp & Hướng dẫn dành cho AI Agents

- Hướng dẫn quy trình làm việc nhóm, phân chia nhánh, mở Pull Request và checklist review: xem tại [CONTRIBUTING.md](CONTRIBUTING.md).
- Hướng dẫn và quy tắc an toàn dành cho AI Coding Assistants (Antigravity, Cursor, Copilot...): xem tại [AGENTS.md](AGENTS.md).
