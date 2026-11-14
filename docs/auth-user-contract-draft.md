# BE-01 — Dự thảo API Contract: Authentication & User

**Trạng thái:** Người dùng đã chọn bcrypt, JWT access token 1 giờ và refresh token 7 ngày. Các endpoint đã được triển khai trên nhánh `feat/auth`; contract vẫn chờ FE 1/Backend xác nhận trước khi merge.

## Mục tiêu và cách tiếp cận

Mục tiêu của BE-01 là chốt giao ước để FE gọi được ba luồng đăng ký, đăng nhập và xem tài khoản. BE-02 hiện thực giao ước đó bằng cấu trúc module hiện có, không thêm nghiệp vụ ngoài issue.

- **Phương án đang đề xuất:** Register, login, refresh, logout và me; dùng bcrypt, JWT access token và refresh token có phiên lưu trong database. Đây là thay đổi phạm vi theo yêu cầu mới; cần duyệt schema phiên trước khi code.
- **Phương án đã cân nhắc:** Toàn bộ API-01 của tài liệu tổng thể. Còn cập nhật hồ sơ, đổi mật khẩu và quản trị tài khoản; các phần này vượt phạm vi hiện tại.

## Phạm vi đề xuất

Phạm vi đề xuất hiện gồm `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout` và `GET /api/v1/users/me`. Refresh là yêu cầu mới; logout cần có để thu hồi phiên refresh. Cập nhật hồ sơ, đổi mật khẩu và quản trị tài khoản vẫn ngoài phạm vi.

## Quy ước chung

- Request và response dùng JSON. `GET /users/me` yêu cầu `Authorization: Bearer <accessToken>`. Refresh token đặt trong HttpOnly Cookie, không trả trong JSON và không gửi trong Authorization header.
- ID trả về là UUID của `User.id`; các mã `USR001` trong tài liệu tổng thể chỉ là ví dụ.
- Lỗi có dạng `{ "success": false, "code": "...", "message": "...", "errors": { "field": ["..."] }, "traceId": "..." }`. `errors` chỉ xuất hiện khi lỗi validation; `traceId` luôn có để đối chiếu lỗi với log. Không đưa thông tin nội bộ, mật khẩu, hash hoặc signing secret vào response.
- Tài khoản đăng ký mặc định có `role: "TENANT"`, `status: "ACTIVE"`. Đăng ký vai trò `LANDLORD` không nằm trong endpoint này; việc nâng vai trò dùng API riêng `POST /api/v1/landlord-verifications` và chỉ diễn ra sau khi Admin duyệt hồ sơ.

## AUTH-01 — Đăng ký

`POST /api/v1/auth/register`

```json
{
  "fullName": "Nguyen Van A",
  "email": "a@example.com",
  "phone": "0901234567",
  "password": "Password@123",
  "confirmPassword": "Password@123",
  "acceptedTerms": true
}
```

`201 Created`:

```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "fullName": "Nguyen Van A",
  "role": "TENANT",
  "status": "ACTIVE"
}
```

Validation đề xuất: `fullName` không rỗng, tối đa 150 ký tự; `email` đúng định dạng và tối đa 255 ký tự, chuẩn hóa chữ thường; `phone` gồm 10 chữ số Việt Nam, bắt đầu bằng `0`; mật khẩu tối thiểu 8 ký tự, tối đa 72 byte UTF-8 (giới hạn bcrypt), có chữ hoa, chữ thường, chữ số và ký tự đặc biệt; `confirmPassword` phải khớp; `acceptedTerms` phải là `true`. Không nhận `role` hoặc `status` từ client.

Lỗi: `400 VALIDATION_ERROR` cho dữ liệu không hợp lệ; `409 EMAIL_ALREADY_EXISTS` hoặc `PHONE_ALREADY_EXISTS` khi trùng, kể cả khi PostgreSQL báo unique constraint; `500 INTERNAL_ERROR` cho lỗi không dự kiến.

## AUTH-02 — Đăng nhập

`POST /api/v1/auth/login`

```json
{ "username": "a@example.com", "password": "Password@123" }
```

`username` là email hoặc số điện thoại. Đề xuất bỏ `rememberMe`: refresh token đã có thời hạn cố định 7 ngày. Response đề xuất:

```json
{
  "user": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "role": "TENANT",
    "status": "ACTIVE"
  },
  "accessToken": "eyJ...",
  "expiresIn": 3600
}
```

Header `Set-Cookie` cấp refresh token với `HttpOnly`, thời hạn 7 ngày. `Bearer` là cách gửi access token trong header `Authorization`, nên không lặp lại dưới trường `tokenType`.

Lỗi: `400 VALIDATION_ERROR` cho input sai; `401 INVALID_CREDENTIALS` với thông báo chung cho tài khoản không tồn tại hoặc sai mật khẩu; `403 ACCOUNT_LOCKED` cho tài khoản bị khóa/đình chỉ; `500 INTERNAL_ERROR` cho lỗi không dự kiến. Cần chốt ngưỡng và thời hạn khóa tạm sau đăng nhập sai.

## AUTH-03 — Làm mới access token

`POST /api/v1/auth/refresh` nhận refresh token qua HttpOnly Cookie, không cần body hay access token. Khi token hợp lệ, chưa hết 7 ngày và phiên chưa bị thu hồi, server xoay vòng refresh token, trả cookie mới và JSON `200 OK`:

```json
{ "accessToken": "eyJ...", "expiresIn": 3600 }
```

Refresh token cũ bị vô hiệu hóa sau khi xoay vòng. Lỗi `401 UNAUTHORIZED` khi cookie thiếu, sai, hết hạn hoặc phiên bị thu hồi; xóa cookie lỗi.

## AUTH-04 — Đăng xuất

`POST /api/v1/auth/logout` thu hồi refresh session hiện tại và xóa cookie; trả `200 OK` với `{ "message": "Đăng xuất thành công" }` theo tài liệu tổng thể. Access token JWT đã phát hành còn hiệu lực tối đa 1 giờ, trừ khi bổ sung cơ chế thu hồi JWT riêng.

## USER-01 — Hồ sơ của tôi

`GET /api/v1/users/me` với Bearer token. `200 OK` chỉ trả các trường hiện có trong Prisma `User`:

```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "fullName": "Nguyen Van A",
  "email": "a@example.com",
  "phone": "0901234567",
  "role": "TENANT",
  "status": "ACTIVE"
}
```

Lỗi: `401 UNAUTHORIZED` khi thiếu, sai hoặc hết hạn token; `403 ACCOUNT_LOCKED` nếu tài khoản hiện bị khóa; `404 USER_NOT_FOUND` nếu tài khoản đã không còn tồn tại. Middleware phải đọc trạng thái hiện tại từ database để khóa tài khoản có hiệu lực với token đã cấp.

## Những điểm phải chốt trước khi merge

1. **FE 1:** Xác nhận ba endpoint, tên trường, mã lỗi và response trên đáp ứng UI. Đây là điều kiện nghiệm thu BE-01 trong issue #7.
2. **Nguồn nghiệp vụ:** Cần cung cấp UC-01/02/03 và Business Rules bản chính thức để kiểm tra các điều kiện chưa có trong tài liệu tổng thể.
3. **Phiên/token:** JWT access token 1 giờ; refresh token 7 ngày theo lựa chọn của người dùng. Bản triển khai dùng token ngẫu nhiên, chỉ lưu hash trong bảng `refresh_sessions` mới; xoay vòng mỗi lần refresh và thu hồi family khi logout. Refresh/logout dùng transaction Serializable và retry xung đột. Cần chốt `Secure`/`SameSite` và CORS theo origin FE và BE. Access token cũ không thể bị thu hồi tức thời chỉ bằng việc thu hồi refresh token.
4. **Mật khẩu:** Bản triển khai dùng bcrypt 12 rounds và `bcrypt.compare` khi đăng nhập, theo lựa chọn của người dùng. Dependency `bcrypt` và type tương ứng đã được thêm. Không dùng `crypto.scrypt`.
5. **Khóa đăng nhập:** Prisma chưa có trường theo dõi số lần đăng nhập sai hay thời điểm khóa tạm. Cần duyệt thay đổi schema hoặc điều chỉnh quy tắc trước khi triển khai.
6. **Hồ sơ:** `dateOfBirth`, `gender`, `permanentAddress`, `avatarUrl` trong tài liệu tổng thể chưa có ở Prisma `User`; không thể trả các trường này như dữ liệu thật nếu chưa đổi schema.
7. **Môi trường:** README yêu cầu Node.js 24, còn máy hiện chạy Node.js 22 và chưa có `.env`. Cần môi trường Node 24 và PostgreSQL để chạy đủ checklist xác minh.
8. **Nâng cấp Chủ trọ:** Tài liệu tổng thể đã có `POST /api/v1/landlord-verifications`, nhưng body ví dụ (`identityNumber`, `legalName`, `fileIds`) không khớp `LandlordApplication` hiện tại (`cccdFrontUrl`, `cccdBackUrl`, `ownershipProofUrl`). Cần chốt payload hoặc schema trước khi triển khai API này; không thuộc phần xác thực hiện tại.

## Kế hoạch triển khai ngắn

1. FE 1/Backend review các điểm còn mở và chốt contract.
2. Kiểm tra migration phiên và các test đăng ký, đăng nhập, refresh rotation, logout, xác thực.
3. Chạy test, `npm run typecheck`, `npm run build`, `npm run db:check`; mở PR vào `staging` theo quy trình repo khi được yêu cầu.

**Nguồn đối chiếu:** issue #7, issue #8, `RentMate_API_Contract.docx` (API-01 và Phụ lục A/B), `prisma/schema.prisma`, `AGENTS.md`, `CONTRIBUTING.md`.
