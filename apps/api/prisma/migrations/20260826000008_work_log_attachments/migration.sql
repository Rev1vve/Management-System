-- Task 8: work-log attachments reuse the shared attachment storage pipeline.
-- Rows are linked to their work log so authorization can join relationally
-- (same pattern as the customer contract FK added in task 7), and so "submit"
-- can atomically rebind draft attachments to the frozen work-log version.
BEGIN;

ALTER TABLE "attachments"
ADD COLUMN IF NOT EXISTS "work_log_id" TEXT;

ALTER TABLE "attachments"
ADD CONSTRAINT "attachments_work_log_id_fkey"
FOREIGN KEY ("work_log_id") REFERENCES "work_logs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "attachments_work_log_id_idx" ON "attachments"("work_log_id");

COMMIT;
