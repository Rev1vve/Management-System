-- Plan D-C: enforce work-log version ownership and append-only history in PostgreSQL.
--
-- 1. work_logs.current_version_id must reference a version that belongs to the same work log.
-- 2. work_log_versions rows are append-only:
--    - structural columns (work_log_id, version_number) can never change;
--    - only the *current* version of a DRAFT work log may have its content updated
--      (draft editing, task 8);
--    - hard DELETE is rejected (product behaviour is soft delete / archival).
--
-- The migration refuses to upgrade a database whose existing rows violate invariant (1),
-- because silently rewriting work-log history is not acceptable.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "work_logs" w
    LEFT JOIN "work_log_versions" v ON v."id" = w."current_version_id"
    WHERE w."current_version_id" IS NOT NULL
      AND (v."id" IS NULL OR v."work_log_id" <> w."id")
  ) THEN
    RAISE EXCEPTION 'work log version guard migration requires consistent current_version_id rows';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "work_log_current_version_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."current_version_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "work_log_versions" v
    WHERE v."id" = NEW."current_version_id"
      AND v."work_log_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'work log current version must belong to the same work log'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "work_logs_current_version_guard"
BEFORE INSERT OR UPDATE OF "current_version_id" ON "work_logs"
FOR EACH ROW EXECUTE FUNCTION "work_log_current_version_guard"();

CREATE OR REPLACE FUNCTION "work_log_version_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_version_id TEXT;
  log_status "WorkLogStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'work log versions are append-only (delete rejected)'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."work_log_id" <> OLD."work_log_id"
     OR NEW."version_number" <> OLD."version_number" THEN
    RAISE EXCEPTION 'work log version structure is immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT w."current_version_id", w."status"
    INTO current_version_id, log_status
  FROM "work_logs" w
  WHERE w."id" = OLD."work_log_id";

  IF OLD."id" IS DISTINCT FROM current_version_id OR log_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only the current version of a draft work log may be edited'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "work_log_versions_immutable_guard"
BEFORE UPDATE OR DELETE ON "work_log_versions"
FOR EACH ROW EXECUTE FUNCTION "work_log_version_immutable_guard"();

COMMIT;
