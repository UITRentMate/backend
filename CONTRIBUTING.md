# Quy Trình Đóng Góp & Phát Triển (Backend)

Tài liệu này quy định quy trình làm việc nhóm trên repository **RentMate Backend**, áp dụng cho đội hình 2 lập trình viên Backend và quá trình phối hợp tích hợp với đội Frontend.

---

## 1. Mô hình phân nhánh (Branching Strategy)

Dự án áp dụng mô hình phân nhánh tinh gọn (Trunk-leaning with Integration Branch):

- **`main`:** Nhánh mã nguồn ổn định đã được kiểm thử, đóng vai trò mốc phát hành sau mỗi giai đoạn (Milestone Release).
  - *Lưu ý:* Dự án hiện tại đang trong giai đoạn phát triển đồ án sinh viên, chưa triển khai môi trường production trực tuyến. Nhánh `main` phản ánh phiên bản ổn định nhất của codebase.
- **`staging`:** Nhánh tích hợp chính (Integration Branch) của Backend.
  - Mọi nhánh tính năng, sửa lỗi đều xuất phát từ `staging` và mở Pull Request (PR) quay về `staging`.
  - Toàn bộ việc kiểm thử API và ghép nối với Frontend diễn ra trên nhánh này trước khi hợp nhất vào `main`.

---

## 2. Quy tắc đặt tên nhánh (Branch Naming)

Mọi thành viên phát triển bắt buộc phải tạo nhánh riêng rẽ từ nhánh `staging` mới nhất theo cú pháp:

`<loại_nhánh>/<mô_tả_ngắn_gọn>`

| Tiền tố | Mục đích | Ví dụ minh họa |
| :--- | :--- | :--- |
| `feat/` | Phát triển module, service, hoặc endpoint API mới | `feat/auth-register-login`, `feat/room-management-api` |
| `fix/` | Sửa lỗi logic nghiệp vụ, sửa lỗi truy vấn, vá bảo mật | `fix/invoice-total-calculation`, `fix/token-expiration-check` |
| `docs/` | Bổ sung, chỉnh sửa tài liệu hoặc hướng dẫn dự án | `docs/project-guidelines`, `docs/api-contracts` |
| `refactor/`| Cải tiến cấu trúc mã nguồn mà không làm đổi hành vi API | `refactor/extract-contract-service`, `refactor/cleanup-middlewares` |
| `test/` | Bổ sung hoặc cập nhật kiểm thử tự động | `test/auth-service-unit-tests` |

---

## 3. Quy tắc an toàn nhánh (Branch Protection Rules)

1. **Tuyệt đối KHÔNG commit hoặc push trực tiếp vào `main`:**
   - Mã nguồn chỉ vào `main` thông qua Pull Request được duyệt từ `staging` khi kết thúc milestone.
2. **Tuyệt đối KHÔNG commit hoặc push trực tiếp vào `staging` trong quy trình làm việc thường ngày:**
   - Mọi thay đổi đều phải thông qua Feature Branch và Pull Request.
3. **Mỗi Issue trên GitHub phải có phân công cụ thể:**
   - Mỗi Issue cần có một Assignee rõ ràng chịu trách nhiệm chính trước khi bắt đầu tạo branch.

---

## 4. Chuẩn hóa Commit Message (Conventional Commits)

Commit message cần rõ ràng, súc tích và tuân thủ định dạng:

`<type>: <mô tả ngắn bằng tiếng Việt hoặc tiếng Anh>`

Các kiểu `type` thông dụng:
- `feat`: Tính năng hoặc endpoint mới (ví dụ `feat: implement rental request creation endpoint`).
- `fix`: Sửa lỗi (ví dụ `fix: prevent duplicate meter reading per invoice`).
- `docs`: Cập nhật tài liệu (ví dụ `docs: add database setup guide in README`).
- `refactor`: Tái cấu trúc code (ví dụ `refactor: simplify error handling middleware`).
- `chore`: Tác vụ bảo trì, dependencies (ví dụ `chore: update prisma client`).

---

## 5. Quy trình làm việc với Pull Request (PR)

### 5.1. Các bước thực hiện một tính năng
1. **Lấy mã nguồn mới nhất:**
   ```bash
   git checkout staging
   git pull origin staging
   ```
2. **Tạo nhánh tính năng:**
   ```bash
   git checkout -b feat/ten-tinh-nang
   ```
3. **Phát triển và tự kiểm thử cục bộ:**
   - Bám sát 23 Business Rules và 38 Use Cases đã được phân tích.
   - Kiểm tra kiểu dữ liệu: `npm run typecheck`.
   - Kiểm tra biên dịch: `npm run build`.
   - Kiểm tra kết nối CSDL: `npm run db:check`.
   - Kiểm tra endpoint `/health` hoạt động bình thường.
4. **Đẩy nhánh lên GitHub:**
   ```bash
   git push origin feat/ten-tinh-nang
   ```
5. **Mở Pull Request vào nhánh `staging`:**
   - Đặt tiêu đề rõ ràng khớp với commit chính.
   - Nội dung PR phải liên kết với GitHub Issue tương ứng (ví dụ: `Closes #8` hoặc `Refs #10`).
   - Mô tả tóm tắt: Danh sách endpoints mới, các tham số đầu vào (request body/query), mã phản hồi HTTP và dữ liệu mẫu trả về.
   - Không tự ý thêm các phần việc ngoài phạm vi Issue.

### 5.2. Phối hợp với đội Frontend & Thống nhất API Contract
- **Nguyên tắc hợp tác:**
  - Đội Backend chịu trách nhiệm cung cấp tài liệu API Contract (endpoint URL, HTTP method, headers, request body schema, response schema, error codes) cho đội Frontend.
  - Trước khi thay đổi cấu trúc dữ liệu trả về của bất kỳ API nào, thành viên Backend **bắt buộc phải thảo luận và thông báo** cho 3 thành viên Frontend để cùng điều chỉnh, tránh làm gãy ứng dụng giao diện.

### 5.3. Xử lý xung đột mã nguồn (Merge Conflict)
- Nếu nhánh `staging` trên remote có thay đổi mới:
  ```bash
  git checkout staging
  git pull origin staging
  git checkout feat/ten-tinh-nang
  git merge staging   # hoặc git rebase staging nếu quen thuộc
  ```
- Giải quyết xung đột cục bộ cẩn trọng.
- **Tuyệt đối không được ghi đè (overwrite) hoặc xóa bỏ mã nguồn của thành viên khác** mà không có sự trao đổi trước.

---

## 6. Checklist Review trước khi Merge PR

Trước khi phê duyệt và hợp nhất một Pull Request vào `staging`, người review (thành viên Backend còn lại hoặc thành viên nhóm) và người tạo PR cần rà soát:

- [ ] **Mã nguồn biên dịch thành công:** `npm run typecheck` và `npm run build` đều chạy đạt mã thoát 0.
- [ ] **Kết nối CSDL ổn định:** `npm run db:check` chạy thành công.
- [ ] **Bảo mật dữ liệu:** Tuyệt đối không trả về mật khẩu người dùng dưới cả hai dạng (`passwordHash` trong Prisma model và `password_hash` trong PostgreSQL column), thông tin đăng nhập (credentials), signing secrets hoặc dữ liệu nhạy cảm trong bất kỳ API response nào. Việc cấp access token hợp lệ chỉ được thực hiện thông qua các endpoint xác thực (Authentication API) theo đúng API Contract đã thống nhất.
- [ ] **Tính sạch sẽ:** Không có file `.env`, file log, `node_modules` hay file tạm của hệ điều hành lọt vào PR.
- [ ] **Tương thích API Contract:** Cấu trúc JSON trả về đúng với giao ước đã thống nhất với đội Frontend.
- [ ] **Phê duyệt:** Nhận được ít nhất 1 phê duyệt (Approval) từ thành viên trong nhóm.
