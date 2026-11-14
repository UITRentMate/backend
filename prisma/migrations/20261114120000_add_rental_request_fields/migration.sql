-- AlterTable
ALTER TABLE "rental_requests" ADD COLUMN "duration_months" INTEGER,
ADD COLUMN "message" TEXT,
ADD COLUMN "rejection_reason" TEXT;

-- CreateIndex
CREATE INDEX "rental_requests_room_id_idx" ON "rental_requests"("room_id");

-- CreateIndex
CREATE INDEX "rental_requests_tenant_id_idx" ON "rental_requests"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "rental_requests_tenant_room_pending_idx" ON "rental_requests"("tenant_id", "room_id") WHERE "status" = 'PENDING';
