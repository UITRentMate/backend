-- Enforce case-insensitive uniqueness of room_code per property at PostgreSQL engine level
CREATE UNIQUE INDEX IF NOT EXISTS "uq_rooms_property_room_code_lower" ON "rooms" ("property_id", LOWER("room_code"));
