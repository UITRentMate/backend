-- Add nullable fields required by the viewing appointment API.
ALTER TABLE "viewing_appointments"
  ADD COLUMN "note" TEXT,
  ADD COLUMN "rejection_reason" TEXT,
  ADD COLUMN "cancellation_reason" TEXT;