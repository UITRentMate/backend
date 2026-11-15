-- ============================================================================
-- ĐỀ XUẤT MIGRATION: [BE-P2-02] RÀNG BUỘC MÃ PHÒNG DUY NHẤT THEO KHU TRỌ
-- Issue: #15 (BE-P2-02)
-- Bảng áp dụng: public.rooms
-- ============================================================================

-- BƯỚC 1: KIỂM TRA DỮ LIỆU TRÙNG LẶP THEO CASE-INSENSITIVE (LOWER)
-- Trước khi áp dụng unique index, chạy câu lệnh này để đảm bảo không có cặp (property_id, LOWER(room_code)) nào bị trùng:
SELECT 
    property_id, 
    LOWER(room_code) as normalized_room_code, 
    COUNT(*) as duplicate_count,
    ARRAY_AGG(id) as room_ids,
    ARRAY_AGG(room_code) as original_room_codes
FROM rooms
GROUP BY property_id, LOWER(room_code)
HAVING COUNT(*) > 1;

-- BƯỚC 2: PHƯƠNG ÁN XỬ LÝ NẾU PHÁT HIỆN DỮ LIỆU TRÙNG LẶP (BẢO TOÀN DỮ LIỆU, KHÔNG XÓA)
-- Cập nhật thêm hậu tố '-DUP-1', '-DUP-2' cho các bản ghi tạo sau:
-- WITH duplicates AS (
--     SELECT id, room_code,
--            ROW_NUMBER() OVER (PARTITION BY property_id, LOWER(room_code) ORDER BY created_at ASC) as r_num
--     FROM rooms
-- )
-- UPDATE rooms r
-- SET room_code = r.room_code || '-DUP-' || (d.r_num - 1)
-- FROM duplicates d
-- WHERE r.id = d.id AND d.r_num > 1;

-- BƯỚC 3: DDL CÂU LỆNH TẠO UNIQUE INDEX TRÊN POSTGRESQL
-- Khi dữ liệu đã sạch, tạo unique index phân biệt không hoa thường (Case-Insensitive Unique Index):
CREATE UNIQUE INDEX IF NOT EXISTS "uq_rooms_property_room_code_lower" 
ON "rooms" ("property_id", LOWER("room_code"));

-- BƯỚC 4: THAY ĐỔI TƯƠNG ỨNG TRONG APPLICATION LAYER VÀ PRISMA SCHEMA
-- 1. Ở Application Layer (Codebase Backend):
--    Đã thực thi kiểm tra `LOWER(TRIM(room_code))` bên trong database transaction client (`tx.room.count`)
--    của cả `createRoomTransaction` và `updateRoomTransaction` để ngăn chặn tuyệt đối tình trạng race condition
--    khi nhiều request đồng thời cố gắng tạo hoặc sửa mã phòng giống nhau (kể cả khác casing).
--
-- 2. Trong Prisma Schema (prisma/schema.prisma) khi được nhóm phê duyệt migration:
-- model Room {
--   id               String   @id @default(uuid()) @db.Uuid
--   propertyId       String   @map("property_id") @db.Uuid
--   roomCode         String   @map("room_code") @db.VarChar(50)
--   ...
--   @@unique([propertyId, roomCode], map: "uq_rooms_property_room_code")
--   @@map("rooms")
-- }
-- *Lưu ý: Nếu sử dụng raw Prisma @@unique([propertyId, roomCode]), DB index mặc định là case-sensitive.
--  Do đó khuyến nghị sử dụng functional index "uq_rooms_property_room_code_lower" qua migration SQL
--  để đảm bảo tính toàn vẹn 100% case-insensitive ở tầng PostgreSQL engine.
