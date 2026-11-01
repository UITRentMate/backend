# Hướng Dẫn Kỹ Thuật Dành Cho AI Coding Agents (Backend)

Tài liệu này xác lập các nguyên tắc bắt buộc đối với tất cả các trợ lý trí tuệ nhân tạo (AI Coding Assistants: Antigravity, Cursor, GitHub Copilot, ChatGPT...) khi tham gia đọc hiểu, tạo mới hoặc chỉnh sửa mã nguồn tại repository **RentMate Backend**.

---

## 1. Nguyên tắc kỹ thuật cốt lõi

1. **Pragmatic Clean Code (Thực dụng và Tinh gọn):**
   - Đây là đồ án môn học sinh viên (Nhóm 15 gồm 5 thành viên), không phải hệ thống enterprise.
   - Ưu tiên tính rõ ràng, cấu trúc trực quan và bảo đảm tính toàn vẹn dữ liệu.
   - Tuyệt đối **không over-engineering**, không tự ý áp đặt các mẫu kiến trúc phức tạp (CQRS, Event Sourcing, Domain-Driven Design nặng nề) khi bài toán chỉ yêu cầu CRUD và kiểm soát nghiệp vụ thông thường.
2. **Đọc trước khi viết (Read Before Write):**
   - Luôn kiểm tra các file liên quan trước khi chỉnh sửa.
   - Giữ nguyên cấu hình TypeScript CommonJS hiện tại (`"module": "CommonJS"` trong `tsconfig.json`). Tuyệt đối không tự chuyển đổi sang ES Modules (ESM) hoặc can thiệp cấu hình hệ thống module.
3. **Không tự ý thêm thư viện ngoài (No Dependency Creep):**
   - Tuyệt đối không tự ý chạy `npm install` thêm các package bên ngoài nếu người dùng không yêu cầu cụ thể.
   - Tận dụng tối đa các thư viện đã được cài đặt và kiểm thử: Express 5, Prisma 6.19.3, và các API native của Node.js 24.

---

## 2. Quy chuẩn kiến trúc & Phát triển Backend

1. **Tuân thủ Kiến trúc Modular Monolith & Phân tầng nhẹ:**
   - Mã nguồn được phân chia theo module nghiệp vụ tại `src/modules/<module_name>/`.
   - Luồng xử lý tiêu chuẩn:
     ```
     Request ──► Route ──► Controller ──► Service ──► Prisma Client ──► Database
                                            │
                                            ▼ (khi cần câu lệnh phức tạp)
                                        Repository
     ```
2. **Quy tắc phân định trách nhiệm các tầng:**
   - **Controller:** Chỉ tiếp nhận HTTP Request, trích xuất dữ liệu đầu vào (params, query, body), gọi Service tương ứng, và trả về HTTP Response chuẩn. Tuyệt đối không viết Business Logic hoặc truy vấn CSDL trực tiếp trong Controller.
   - **Service:** Là nơi tập trung **toàn bộ Business Logic**, kiểm tra điều kiện nghiệp vụ, và thực thi các Database Transactions khi cần cập nhật nhiều bảng cùng lúc.
   - **Repository:** Chỉ tạo khi một thực thể có các truy vấn SQL thô hoặc logic lọc phức tạp vượt ra ngoài khả năng thuận tiện của Prisma Client. Với các thao tác thông thường, Service được phép gọi trực tiếp Prisma Client để giữ code gọn gàng, không ép buộc tạo Repository rỗng chỉ để ủy quyền lệnh.
3. **Quản lý Kết nối Cơ sở dữ liệu:**
   - Luôn sử dụng thể hiện PrismaClient singleton chung được export từ [src/infrastructure/database/prisma.ts](src/infrastructure/database/prisma.ts).
   - Tuyệt đối không tự ý `new PrismaClient()` ở bất kỳ module nào khác để tránh gây cạn kiệt connection pool của PostgreSQL.
4. **Bảo mật & Che giấu dữ liệu nhạy cảm (Security):**
   - **Tuyệt đối không bao giờ** trả về trường mật khẩu của người dùng — dù là dưới tên field trong Prisma model (`passwordHash`) hay tên cột trong PostgreSQL database (`password_hash`) — trong bất kỳ API response nào.
   - Không để lộ mật khẩu, `passwordHash`, `password_hash`, chuỗi kết nối chứa thông tin đăng nhập hoặc tokens bí mật qua console log hay file log.
5. **Cơ sở dữ liệu & Prisma Migrations:**
   - Cơ sở dữ liệu hiện đã có Initial Migration hoàn chỉnh với 32 bảng nghiệp vụ.
   - **Tuyệt đối KHÔNG** tự ý chỉnh sửa file `prisma/schema.prisma` hoặc chạy các lệnh migration (`prisma migrate dev`, `prisma db push`, `prisma migrate reset`) nếu không có chỉ thị và phê duyệt riêng từ người dùng.

---

## 3. Ranh giới an toàn & Quy tắc Git (Safety Boundaries)

> [!IMPORTANT]
> **Phân biệt vai trò:** Các quy tắc dưới đây là ràng buộc an toàn bắt buộc dành riêng cho **AI Agents**. Thành viên con người trong nhóm vẫn thực hiện quy trình Git thông thường được mô tả tại [CONTRIBUTING.md](CONTRIBUTING.md).

1. **Không mở rộng phạm vi (Zero Scope Creep):**
   - Chỉ giải quyết duy nhất nội dung yêu cầu thuộc Issue hoặc prompt được giao.
   - Không tự ý thêm routes, endpoints, hay controllers ngoài phạm vi task hiện tại.
2. **Quy tắc an toàn Git của AI:**
   - **Không tự động stage, commit hoặc push:** Tuyệt đối không tự ý thực hiện bất kỳ thao tác thay đổi trạng thái Git nào trừ khi nhận được chỉ thị rõ ràng từ người dùng.
   - **Quy trình bắt buộc trước khi thao tác Git:** Chỉ thực hiện khi người dùng yêu cầu cụ thể, và bắt buộc phải kiểm tra branch hiện tại, trạng thái working tree (`git status`) và xem xét diff (`git diff`) trước khi làm.
   - **Khi stage:** Chỉ stage đích danh các file thuộc phạm vi task đã được phê duyệt. Tuyệt đối **không** dùng `git add .` hoặc `git add -A`.
   - **Cấm hoàn toàn các thao tác phá hủy dữ liệu:** Không bao giờ chạy `git push --force`, `git reset --hard`, `git clean -fd`, `git checkout -- .`, hoặc `git rebase` nếu chưa có sự phê duyệt rõ ràng.
   - **Xử lý xung đột (Git Conflicts):** Tuyệt đối không tự động giải quyết conflicts bằng cách ghi đè (overwrite) hoặc xóa bỏ mã nguồn của thành viên khác. Khi có conflict, phải dừng lại báo cáo người dùng.
3. **Tôn trọng Business Rules và API Contract:**
   - Bám sát 23 Business Rules và 38 Use Cases của đề án, không tự suy đoán logic nghiệp vụ.
   - Không tự ý đơn phương thay đổi API Contract đã thống nhất với đội Frontend.

---

## 4. Kiểm tra trước khi bàn giao (Verification Checklist)

Mỗi khi hoàn thành một tác vụ code trên Backend, AI Agent bắt buộc phải chạy các lệnh kiểm tra sau trong terminal:

1. **Kiểm tra kiểu dữ liệu:**
   ```bash
   npm run typecheck
   ```
   *Bắt buộc phải đạt 0 lỗi TypeScript (`tsc --noEmit`).*
2. **Kiểm tra biên dịch:**
   ```bash
   npm run build
   ```
   *Bảo đảm mã nguồn được biên dịch thành công sang thư mục `dist/` mà không phát sinh lỗi cú pháp.*
3. **Kiểm tra kết nối Database:**
   ```bash
   npm run db:check
   ```
   *Xác minh kết nối tới PostgreSQL an toàn.*
4. **Kiểm tra trạng thái Git:**
   ```bash
   git status
   ```
   *Bảo đảm không có file `.env`, file build hay file ngoài phạm vi bị tác động.*
