-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "cancellation_reason" TEXT,
ADD COLUMN     "hold_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "tenant_note" TEXT,
ALTER COLUMN "status" SET DATA TYPE VARCHAR(32);

-- AlterTable
ALTER TABLE "repair_tickets" ADD COLUMN     "cost_bearer" VARCHAR(20),
ADD COLUMN     "priority" VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "repair_cost" DECIMAL(14,2),
ADD COLUMN     "resolution_plan" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "address" TEXT,
ADD COLUMN     "avatar_cloudinary_public_id" VARCHAR(255),
ADD COLUMN     "avatar_url" TEXT,
ADD COLUMN     "date_of_birth" DATE;

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_is_read_created_at_idx" ON "notifications"("recipient_id", "is_read", "created_at" DESC);

-- CreateIndex
CREATE INDEX "repair_tickets_property_id_status_idx" ON "repair_tickets"("property_id", "status");

-- CreateIndex
CREATE INDEX "resident_invitations_invited_user_id_status_idx" ON "resident_invitations"("invited_user_id", "status");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==========================================
-- PHASE 3 PARTIAL UNIQUE INDEXES (ANTI-RACE-CONDITION AT POSTGRESQL LEVEL)
-- ==========================================

-- BR-06 & BR-07: At most one live/in-progress contract per room at any time
CREATE UNIQUE INDEX IF NOT EXISTS "uq_contracts_live_room"
ON "contracts" ("room_id")
WHERE "status" IN (
    'DRAFT',
    'PENDING_TENANT_CONFIRMATION',
    'AWAITING_DEPOSIT',
    'DEPOSIT_CONFIRMED',
    'ACTIVE',
    'LIQUIDATING'
);

-- At most one PENDING deposit receipt per contract at any time
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deposit_receipts_pending_contract"
ON "deposit_receipts" ("contract_id")
WHERE "status" = 'PENDING';

-- At most one PENDING landlord verification application per user at any time
CREATE UNIQUE INDEX IF NOT EXISTS "uq_landlord_applications_pending_user"
ON "landlord_applications" ("user_id")
WHERE "status" = 'PENDING';
