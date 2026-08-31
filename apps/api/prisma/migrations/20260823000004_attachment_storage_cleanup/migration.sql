-- Persist physical-file cleanup completion separately from logical attachment archival.
-- Archived rows with a NULL storage_deleted_at remain durable retry work after a crash.
-- This feature has not shipped before this migration. Refuse an upgrade with
-- legacy rows because their filesystem identity cannot be reconstructed safely
-- from database metadata alone.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "attachments") THEN
    RAISE EXCEPTION 'attachment identity migration requires an empty attachments table';
  END IF;
END $$;

ALTER TYPE "AttachmentStatus" ADD VALUE 'PENDING';

ALTER TABLE "attachments"
ADD COLUMN "customer_id" TEXT,
ADD COLUMN "storage_published_at" TIMESTAMPTZ(3),
ADD COLUMN "storage_device" BIGINT,
ADD COLUMN "storage_inode" BIGINT,
ADD COLUMN "storage_deleted_at" TIMESTAMPTZ(3),
ADD COLUMN "storage_cleanup_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "storage_cleanup_last_error" TEXT,
ADD CONSTRAINT "attachments_customer_contract_consistency_check" CHECK (
  (
    "resource_type" = 'CUSTOMER_CONTRACT'
    AND "customer_id" IS NOT NULL
    AND "resource_id" = "customer_id"
  )
  OR
  (
    "resource_type" <> 'CUSTOMER_CONTRACT'
    AND "customer_id" IS NULL
  )
);

CREATE INDEX "attachments_customer_id_idx" ON "attachments"("customer_id");

ALTER TABLE "attachments"
ADD CONSTRAINT "attachments_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "attachments_cleanup_pending_idx"
ON "attachments"("status", "storage_deleted_at", "storage_cleanup_attempts");

CREATE INDEX "attachments_upload_pending_idx"
ON "attachments"("status", "storage_published_at", "storage_cleanup_attempts");

COMMIT;
