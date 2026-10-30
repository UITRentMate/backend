-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "account_status" VARCHAR(25) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landlord_applications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reviewer_id" UUID,
    "cccd_front_url" TEXT NOT NULL,
    "cccd_back_url" TEXT NOT NULL,
    "ownership_proof_url" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "rejection_reason" TEXT,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(6),

    CONSTRAINT "landlord_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "properties" (
    "id" UUID NOT NULL,
    "landlord_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "address" TEXT NOT NULL,
    "house_rules" TEXT,
    "cover_image_url" TEXT,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_code" VARCHAR(50) NOT NULL,
    "floor" INTEGER,
    "area_m2" DECIMAL(8,2) NOT NULL,
    "max_occupants" INTEGER NOT NULL,
    "monthly_rent" DECIMAL(14,2) NOT NULL,
    "deposit_required" DECIMAL(14,2) NOT NULL,
    "electricity_rate" DECIMAL(12,2) NOT NULL,
    "water_rate" DECIMAL(12,2) NOT NULL,
    "occupancy_status" VARCHAR(25) NOT NULL,
    "visibility_status" VARCHAR(25) NOT NULL,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amenities" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "scope" VARCHAR(20) NOT NULL,

    CONSTRAINT "amenities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_amenities" (
    "property_id" UUID NOT NULL,
    "amenity_id" UUID NOT NULL,

    CONSTRAINT "property_amenities_pkey" PRIMARY KEY ("property_id","amenity_id")
);

-- CreateTable
CREATE TABLE "room_amenities" (
    "room_id" UUID NOT NULL,
    "amenity_id" UUID NOT NULL,

    CONSTRAINT "room_amenities_pkey" PRIMARY KEY ("room_id","amenity_id")
);

-- CreateTable
CREATE TABLE "room_images" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "image_url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_service_fees" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "fee_name" VARCHAR(100) NOT NULL,
    "monthly_amount" DECIMAL(14,2) NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "room_service_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viewing_appointments" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_phone" VARCHAR(20) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "selected_slot_id" UUID,
    "viewed_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "viewing_appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viewing_time_options" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "proposed_by" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "is_selected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "viewing_time_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_requests" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "desired_start_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rental_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rental_request_id" UUID,
    "renewed_from_id" UUID,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" VARCHAR(28) NOT NULL,
    "pending_moveout" BOOLEAN NOT NULL DEFAULT false,
    "rent_snapshot" DECIMAL(14,2) NOT NULL,
    "deposit_snapshot" DECIMAL(14,2) NOT NULL,
    "electricity_rate" DECIMAL(12,2) NOT NULL,
    "water_rate" DECIMAL(12,2) NOT NULL,
    "deposit_carried" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "accepted_at" TIMESTAMPTZ(6),
    "deposit_deadline_at" TIMESTAMPTZ(6),
    "activated_at" TIMESTAMPTZ(6),

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_service_fees" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "fee_name" VARCHAR(100) NOT NULL,
    "monthly_amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "contract_service_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_records" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "handover_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "electricity_e0" DECIMAL(12,3) NOT NULL,
    "water_w0" DECIMAL(12,3) NOT NULL,
    "electric_photo_url" TEXT NOT NULL,
    "water_photo_url" TEXT NOT NULL,

    CONSTRAINT "handover_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_residents" (
    "contract_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),

    CONSTRAINT "contract_residents_pkey" PRIMARY KEY ("contract_id","user_id")
);

-- CreateTable
CREATE TABLE "resident_invitations" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "invited_user_id" UUID NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),

    CONSTRAINT "resident_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_receipts" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "proof_url" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,

    CONSTRAINT "deposit_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "adjusts_invoice_id" UUID,
    "invoice_type" VARCHAR(25) NOT NULL,
    "billing_month" DATE,
    "status" VARCHAR(25) NOT NULL,
    "base_amount" DECIMAL(14,2) NOT NULL,
    "old_debt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "issued_at" TIMESTAMPTZ(6),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "item_type" VARCHAR(25) NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "evidence_url" TEXT,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_readings" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "meter_type" VARCHAR(12) NOT NULL,
    "previous_value" DECIMAL(12,3) NOT NULL,
    "current_value" DECIMAL(12,3) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "photo_url" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payment_proofs" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "submitted_by_id" UUID NOT NULL,
    "amount_reported" DECIMAL(14,2) NOT NULL,
    "proof_url" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "confirmed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,

    CONSTRAINT "invoice_payment_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewal_requests" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "proposed_end_date" DATE NOT NULL,
    "proposed_rent" DECIMAL(14,2),
    "status" VARCHAR(20) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "renewal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "termination_notices" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "notice_date" DATE NOT NULL,
    "planned_moveout" DATE NOT NULL,
    "reason" TEXT,
    "status" VARCHAR(20) NOT NULL,

    CONSTRAINT "termination_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidations" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "actual_moveout" DATE,
    "deposit_credit" DECIMAL(14,2) NOT NULL,
    "final_balance" DECIMAL(14,2) NOT NULL,
    "status" VARCHAR(25) NOT NULL,
    "response_deadline" TIMESTAMPTZ(6),
    "inspection_url" TEXT,
    "unilateral_reason" TEXT,
    "finalized_at" TIMESTAMPTZ(6),

    CONSTRAINT "liquidations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_tickets" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_id" UUID,
    "created_by_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "status" VARCHAR(28) NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_attachments" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "file_url" TEXT NOT NULL,
    "stage" VARCHAR(25) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "repair_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roommate_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "gender" VARCHAR(12) NOT NULL,
    "preferred_gender" VARCHAR(12) NOT NULL,
    "district_keyword" VARCHAR(180) NOT NULL,
    "max_budget" DECIMAL(14,2) NOT NULL,
    "sleep_schedule" VARCHAR(20) NOT NULL,
    "smoking" BOOLEAN NOT NULL,
    "has_pets" BOOLEAN NOT NULL,
    "cooking_frequency" VARCHAR(20) NOT NULL,
    "noise_level" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,

    CONSTRAINT "roommate_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roommate_connections" (
    "id" UUID NOT NULL,
    "sender_profile_id" UUID NOT NULL,
    "receiver_profile_id" UUID NOT NULL,
    "match_score" DECIMAL(5,2),
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMPTZ(6),

    CONSTRAINT "roommate_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaints" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "target_user_id" UUID,
    "target_room_id" UUID,
    "origin_ticket_id" UUID,
    "reason" VARCHAR(60) NOT NULL,
    "evidence_url" TEXT NOT NULL,
    "status" VARCHAR(25) NOT NULL,
    "handled_by_id" UUID,
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "old_data" JSONB,
    "new_data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "payload" JSONB,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "amenities_name_key" ON "amenities"("name");

-- CreateIndex
CREATE UNIQUE INDEX "handover_records_contract_id_key" ON "handover_records"("contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "liquidations_contract_id_key" ON "liquidations"("contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "liquidations_invoice_id_key" ON "liquidations"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "roommate_profiles_user_id_key" ON "roommate_profiles"("user_id");

-- AddForeignKey
ALTER TABLE "landlord_applications" ADD CONSTRAINT "landlord_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landlord_applications" ADD CONSTRAINT "landlord_applications_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_landlord_id_fkey" FOREIGN KEY ("landlord_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_amenities" ADD CONSTRAINT "property_amenities_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_amenities" ADD CONSTRAINT "property_amenities_amenity_id_fkey" FOREIGN KEY ("amenity_id") REFERENCES "amenities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_amenities" ADD CONSTRAINT "room_amenities_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_amenities" ADD CONSTRAINT "room_amenities_amenity_id_fkey" FOREIGN KEY ("amenity_id") REFERENCES "amenities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_images" ADD CONSTRAINT "room_images_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_service_fees" ADD CONSTRAINT "room_service_fees_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewing_appointments" ADD CONSTRAINT "viewing_appointments_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewing_appointments" ADD CONSTRAINT "viewing_appointments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewing_appointments" ADD CONSTRAINT "viewing_appointments_selected_slot_id_fkey" FOREIGN KEY ("selected_slot_id") REFERENCES "viewing_time_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewing_appointments" ADD CONSTRAINT "viewing_appointments_viewed_by_id_fkey" FOREIGN KEY ("viewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewing_time_options" ADD CONSTRAINT "viewing_time_options_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "viewing_appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewing_time_options" ADD CONSTRAINT "viewing_time_options_proposed_by_fkey" FOREIGN KEY ("proposed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_requests" ADD CONSTRAINT "rental_requests_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_requests" ADD CONSTRAINT "rental_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_rental_request_id_fkey" FOREIGN KEY ("rental_request_id") REFERENCES "rental_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_renewed_from_id_fkey" FOREIGN KEY ("renewed_from_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_service_fees" ADD CONSTRAINT "contract_service_fees_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_records" ADD CONSTRAINT "handover_records_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_residents" ADD CONSTRAINT "contract_residents_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_residents" ADD CONSTRAINT "contract_residents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resident_invitations" ADD CONSTRAINT "resident_invitations_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resident_invitations" ADD CONSTRAINT "resident_invitations_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resident_invitations" ADD CONSTRAINT "resident_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_receipts" ADD CONSTRAINT "deposit_receipts_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_receipts" ADD CONSTRAINT "deposit_receipts_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_adjusts_invoice_id_fkey" FOREIGN KEY ("adjusts_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payment_proofs" ADD CONSTRAINT "invoice_payment_proofs_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payment_proofs" ADD CONSTRAINT "invoice_payment_proofs_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payment_proofs" ADD CONSTRAINT "invoice_payment_proofs_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_requests" ADD CONSTRAINT "renewal_requests_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_requests" ADD CONSTRAINT "renewal_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "termination_notices" ADD CONSTRAINT "termination_notices_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "termination_notices" ADD CONSTRAINT "termination_notices_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidations" ADD CONSTRAINT "liquidations_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidations" ADD CONSTRAINT "liquidations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_attachments" ADD CONSTRAINT "repair_attachments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_attachments" ADD CONSTRAINT "repair_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roommate_profiles" ADD CONSTRAINT "roommate_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roommate_connections" ADD CONSTRAINT "roommate_connections_sender_profile_id_fkey" FOREIGN KEY ("sender_profile_id") REFERENCES "roommate_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roommate_connections" ADD CONSTRAINT "roommate_connections_receiver_profile_id_fkey" FOREIGN KEY ("receiver_profile_id") REFERENCES "roommate_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_target_room_id_fkey" FOREIGN KEY ("target_room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_origin_ticket_id_fkey" FOREIGN KEY ("origin_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
