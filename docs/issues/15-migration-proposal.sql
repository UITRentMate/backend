-- ============================================================================
-- ĐỀ XUẤT MIGRATION: [BE-P2-02] RÀNG BUỘC MÃ PHÒNG DUY NHẤT THEO KHU TRỌ
-- Issue: #15 (BE-P2-02)
-- Bảng áp dụng: public.rooms
-- ============================================================================

-- BƯỚC 1: KIỂM TRA DỮ LIỆU TRÙNG LẶP HIỆN CÓ
-- Trước khi áp dụng unique index, chạy câu lệnh này để đảm bảo không có cặp (property_id, room_code) nào bị trùng:
SELECT 
    property_id, 
    room_code, 
    COUNT(*) as duplicate_count,
    ARRAY_AGG(id) as room_ids
FROM rooms
GROUP BY property_id, room_code
HAVING COUNT(*) > 1;

-- BƯỚC 2: PHƯƠNG ÁN XỬ LÝ NẾU PHÁT HIỆN DỮ LIỆU TRÙNG LẶP (BẢO TOÀN DỮ LIỆU, KHÔNG XÓA)
-- Cập nhật thêm hậu tố '-DUP-1', '-DUP-2' cho các bản ghi tạo sau:
-- WITH duplicates AS (
--     SELECT id, room_code,
--            ROW_NUMBER() OVER (PARTITION BY property_id, room_code ORDER BY created_at ASC) as r_num
--     FROM rooms
-- )
-- UPDATE rooms r
-- SET room_code = r.room_code || '-DUP-' || (d.r_num - 1)
-- FROM duplicates d
-- WHERE r.id = d.id AND d.r_num > 1;

-- BƯỚC 3: DDL CÂU LỆNH TẠO UNIQUE INDEX TRÊN POSTGRESQL
-- Khi dữ liệu đã sạch, tạo unique constraint/index:
CREATE UNIQUE INDEX IF NOT EXISTS "uq_rooms_property_room_code" 
ON "rooms" ("property_id", "room_code");

-- BƯỚC 4: THAY ĐỔI TƯƠNG ỨNG TRONG PRISMA SCHEMA (prisma/schema.prisma)
-- model Room {
--   id               String   @id @default(uuid()) @db.Uuid
--   propertyId       String   @map("property_id") @db.Uuid
--   roomCode         String   @map("room_code") @db.VarChar(50)
--   ...
--   @@unique([propertyId, roomCode], map: "uq_rooms_property_room_code")
--   @@map("rooms")
-- }
