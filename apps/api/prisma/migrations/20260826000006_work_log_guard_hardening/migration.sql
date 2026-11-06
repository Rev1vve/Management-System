-- Plan D-C hardening (review-8 findings):
-- 1. The immutable guard re-read the parent work_log without locking, so under READ COMMITTED a
--    concurrent uncommitted `status='SUBMITTED'` was invisible and a submitted version could still
--    be rewritten. Take a row lock (`FOR UPDATE`) so the guard serializes with status changes.
-- 2. `work_logs.status` had no transition constraint, so `UPDATE status='DRAFT'` re-opened a
--    submitted version for editing. Enforce the product state machine in the database.
-- 3. Row triggers do not fire for TRUNCATE; reject it explicitly on the version table.
-- 4. Structure check now also pins the primary key; a soft-deleted log may no longer be edited.
BEGIN;

CREATE OR REPLACE FUNCTION "work_log_version_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_version_id TEXT;
  log_status "WorkLogStatus";
  log_deleted_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'work log versions are append-only (delete rejected)'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."work_log_id" <> OLD."work_log_id"
     OR NEW."version_number" <> OLD."version_number" THEN
    RAISE EXCEPTION 'work log version structure is immutable'
      USING ERRCODE = '23514';
  END IF;

  -- FOR UPDATE: hold the parent row so a concurrent status change cannot be missed
  -- through the statement snapshot.
  SELECT w."current_version_id", w."status", w."deleted_at"
    INTO current_version_id, log_status, log_deleted_at
  FROM "work_logs" w
  WHERE w."id" = OLD."work_log_id"
  FOR UPDATE;

  IF OLD."id" IS DISTINCT FROM current_version_id
     OR log_status <> 'DRAFT'
     OR log_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'only the current version of a draft work log may be edited'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "work_log_versions_immutable_guard" ON "work_log_versions";
CREATE TRIGGER "work_log_versions_immutable_guard"
BEFORE UPDATE OR DELETE ON "work_log_versions"
FOR EACH ROW EXECUTE FUNCTION "work_log_version_immutable_guard"();

-- Product state machine: DRAFT -> SUBMITTED -> APPROVED|RETURNED|REJECTED, RETURNED -> DRAFT.
CREATE OR REPLACE FUNCTION "work_log_status_transition_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF (OLD."status" = 'DRAFT' AND NEW."status" = 'SUBMITTED')
     OR (OLD."status" = 'SUBMITTED'
         AND NEW."status" IN ('APPROVED', 'RETURNED', 'REJECTED'))
     OR (OLD."status" = 'RETURNED' AND NEW."status" = 'DRAFT') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal work log status transition % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END $$;

DROP TRIGGER IF EXISTS "work_logs_status_transition_guard" ON "work_logs";
CREATE TRIGGER "work_logs_status_transition_guard"
BEFORE UPDATE OF "status" ON "work_logs"
FOR EACH ROW EXECUTE FUNCTION "work_log_status_transition_guard"();

-- 只允许表属主（迁移/运维身份）TRUNCATE；运行时应用账号按最小权限不拥有表，
-- 因此对 application 角色仍是拒绝（计划：迁移身份与运行时身份分离）。
CREATE OR REPLACE FUNCTION "work_log_versions_truncate_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(
    current_user,
    (SELECT c."relowner" FROM pg_class c WHERE c."oid" = 'public."work_log_versions"'::regclass),
    'USAGE'
  ) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'work log versions are append-only (truncate rejected)'
    USING ERRCODE = '23514';
END $$;

DROP TRIGGER IF EXISTS "work_log_versions_truncate_guard" ON "work_log_versions";
CREATE TRIGGER "work_log_versions_truncate_guard"
BEFORE TRUNCATE ON "work_log_versions"
FOR EACH STATEMENT EXECUTE FUNCTION "work_log_versions_truncate_guard"();

COMMIT;
