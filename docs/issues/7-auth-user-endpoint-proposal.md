# Đề xuất cập nhật API Contract — Authentication, User và nâng cấp Chủ trọ

Liên quan: [BE-01 #7](https://github.com/UITRentMate/backend/issues/7), [BE-02 #8](https://github.com/UITRentMate/backend/issues/8). Đề xuất này cần FE 1 và Backend review trước khi chốt contract/triển khai BE-02.

## 1. Phạm vi API đề xuất cho BE-02

Issue #8 nêu register, login và thông tin người dùng; đề xuất bổ sung refresh và logout theo yêu cầu phiên mới để hai endpoint này được review cùng contract.

| API | Method và URL | Mục đích |
| --- | --- | --- |
| AUTH-01 | `POST /api/v1/auth/register` | Tạo tài khoản `TENANT`, trạng thái `ACTIVE`. Client không gửi `role` hoặc `status`. |
| AUTH-02 | `POST /api/v1/auth/login` | Đăng nhập bằng email hoặc số điện thoại; trả JWT access token 1 giờ và đặt refresh token 7 ngày trong HttpOnly Cookie. |
| AUTH-03 | `POST /api/v1/auth/refresh` | Xoay vòng refresh token, cấp access token mới. |
| AUTH-04 | `POST /api/v1/auth/logout` | Thu hồi refresh session hiện tại và xóa cookie. |
| USER-01 | `GET /api/v1/users/me` | Lấy thông tin tài khoản hiện tại từ JWT; kiểm tra lại trạng thái tài khoản trong DB. |

### AUTH-01 — Register

Request:

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

Mật khẩu được hash bằng **bcrypt** trước khi lưu vào `User.passwordHash`; giới hạn tối đa **72 byte UTF-8** để tránh bcrypt cắt mất phần cuối. Không trả hash trong response. Email và số điện thoại phải duy nhất, kể cả khi hai request đồng thời gây lỗi unique constraint ở PostgreSQL.

### AUTH-02 — Login

Request đề xuất:

```json
{ "username": "a@example.com", "password": "Password@123" }
```

`200 OK`:

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

Dùng **JWT** có chữ ký, secret lấy từ biến môi trường; access token hết hạn sau **1 giờ**. `Bearer` được quy định ở header `Authorization: Bearer <accessToken>`, không cần lặp lại thành `tokenType` trong JSON. Refresh token là chuỗi ngẫu nhiên, đặt qua `Set-Cookie` với `HttpOnly` và hạn **7 ngày**, không trả trong body. Đề xuất bỏ `rememberMe` vì thời hạn refresh đã cố định. Sai tài khoản hoặc sai mật khẩu cùng trả `401 INVALID_CREDENTIALS` với thông báo chung.

### AUTH-03 — Refresh

`POST /api/v1/auth/refresh` không cần body hay access token; browser gửi refresh cookie tự động. Nếu phiên còn hiệu lực, server vô hiệu hóa refresh token cũ, đặt cookie mới và trả `200 OK`:

```json
{ "accessToken": "eyJ...", "expiresIn": 3600 }
```

Nếu cookie thiếu/sai/hết hạn hoặc phiên đã bị thu hồi: `401 UNAUTHORIZED` và xóa cookie. Thời hạn tối đa của một phiên tính từ lần login là **7 ngày**; xoay vòng token không kéo dài mốc này.

### AUTH-04 — Logout

`POST /api/v1/auth/logout` thu hồi refresh session hiện tại, xóa cookie và trả `200 OK` với `{ "message": "Đăng xuất thành công" }` theo bản API Contract tổng thể. Đề xuất dùng refresh cookie cho logout thay vì yêu cầu access token, để vẫn đăng xuất được khi access token đã hết 1 giờ. JWT access token đã phát hành vẫn hợp lệ đến khi hết hạn (tối đa 1 giờ), trừ khi có thêm cơ chế thu hồi JWT.

### USER-01 — Me

`GET /api/v1/users/me` với `Authorization: Bearer <accessToken>`.

`200 OK`:

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

Chỉ trả các trường đang có trong Prisma `User`. Không trả `passwordHash`. Các trường `dateOfBirth`, `gender`, `permanentAddress`, `avatarUrl` trong bản API Contract tổng thể chưa có ở model này.

## 2. API riêng để xin nâng cấp lên Chủ trọ

**Giữ `register` chỉ tạo TENANT.** Người dùng đã đăng nhập gửi hồ sơ qua API riêng, Admin duyệt thì mới chuyển `User.role` sang `LANDLORD`. Việc gửi hồ sơ không tự đổi role.

Tài liệu API Contract tổng thể **đã đề xuất** `POST /api/v1/landlord-verifications` (LAND-01); nên giữ URL đó, không tạo thêm `/auth/register-landlord` hay tham số `role=LANDLORD` cho register.

Payload **đề xuất để khớp Prisma `LandlordApplication` hiện tại**:

```http
POST /api/v1/landlord-verifications
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "cccdFrontUrl": "/files/cccd-front.jpg",
  "cccdBackUrl": "/files/cccd-back.jpg",
  "ownershipProofUrl": "/files/ownership-proof.pdf"
}
```

`201 Created`:

```json
{
  "verificationId": "550e8400-e29b-41d4-a716-446655440001",
  "status": "PENDING"
}
```

`userId` lấy từ JWT, không nhận từ body. Chặn hồ sơ trùng đang `PENDING` bằng `409 APPLICATION_ALREADY_PENDING`. Quy trình xem hồ sơ và Admin duyệt/từ chối dùng các endpoint LAND-02, LAND-04 đến LAND-07 đã có trong tài liệu tổng thể; khi duyệt, cập nhật hồ sơ và `User.role` trong cùng transaction. **Toàn bộ API xác minh Chủ trọ nằm ngoài phạm vi triển khai BE-02.**

**Điểm lệch cần quyết định:** Body LAND-01 trong tài liệu tổng thể dùng `identityNumber`, `legalName`, `propertyProofDescription`, `fileIds`; Prisma hiện chỉ có `cccdFrontUrl`, `cccdBackUrl`, `ownershipProofUrl`. FE 1/Backend cần chọn payload theo schema hiện có như trên, hoặc duyệt sửa schema và luồng upload file. Không lưu URL giả làm bằng chứng thật.

## 3. Lưu phiên refresh và quyết định còn mở

Schema `User` được cung cấp hiện **không có bảng refresh session**. Nhánh `feat/auth` bổ sung model phiên chứa `id`, `userId`, `tokenHash` (unique), `familyId`, `createdAt`, `expiresAt`, `revokedAt`; chỉ lưu hash của refresh token. Mỗi lần refresh tạo token mới, đánh dấu token cũ đã dùng trong transaction; nếu token cũ bị dùng lại, thu hồi các phiên còn hiệu lực cùng `familyId`. Logout thu hồi cả family dù cookie đang giữ token cũ. Refresh/logout dùng transaction Serializable và retry khi PostgreSQL báo xung đột để không bỏ sót phiên vừa xoay vòng. Migration cần được review trước khi áp dụng.

Cookie đề xuất có `HttpOnly`, `Path=/api/v1/auth`, hạn tối đa 7 ngày; `Secure` và `SameSite` cần chốt theo origin của Frontend/Backend. Nếu dùng cookie khác site, cần xét thêm CSRF protection. Không log token hay đưa token vào URL.

## 4. Lỗi và quyết định còn mở

Đề xuất lỗi JSON `{ "success": false, "code": "...", "message": "...", "errors": { "field": ["..."] } }`; `errors` chỉ có khi validation. Dùng `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`/`INVALID_CREDENTIALS`, `403 ACCOUNT_LOCKED`, `409 EMAIL_ALREADY_EXISTS`/`PHONE_ALREADY_EXISTS`/`APPLICATION_ALREADY_PENDING`, và `500 INTERNAL_ERROR`. Cần chốt có bắt buộc `traceId` như Phụ lục A của tài liệu tổng thể không.

- FE 1 xác nhận request/response, việc bỏ `tokenType`/`rememberMe` và payload hồ sơ Chủ trọ.
- Backend duyệt model phiên/migration, chính sách cookie và cách thu hồi refresh token; access token vẫn sống tới hết hạn 1 giờ sau logout.
- Backend chốt cách lưu số lần đăng nhập sai và khóa tạm; schema hiện chưa có trường tương ứng.
- Cung cấp UC-01/02/03 bản chính thức để đối chiếu trước khi duyệt contract.

**Nguồn đối chiếu:** `RentMate_API_Contract.docx` (API-01, API-02, Phụ lục A/B), `prisma/schema.prisma`, `AGENTS.md`, `CONTRIBUTING.md`.
