-- Plan D-C hardening, take 4 (review-10 findings).
--
-- 上一版 (0006) 用 `SELECT ... FOR UPDATE` 回查父行关闭 READ COMMITTED 快照窗口，代价是
-- child→parent 反向锁边（与应用 parent→child 顺序相反），实测可死锁；TRUNCATE 守卫又依赖
-- "运行时角色不是表属主"，而当前单角色部署下恒真放行。改成不读父行、不加锁的方案：
--
-- 1. 版本行新增 `frozen_at`：不可变判定只看本行，不读父行 → 无快照窗口、无额外锁。
-- 2. **由数据库在"状态离开 DRAFT"时自动冻结当前版本**（AFTER UPDATE 触发器），
--    这样即使应用层漏写 frozen_at，历史也不会变得可改（review-10 的 fail-open）。
-- 3. 状态机补 INSERT 约束：新建工作日志只允许 DRAFT。
-- 4. 撤掉 TRUNCATE 触发器：单角色部署下它只是假守卫；历史被属主清空属于运维/备份范畴，
--    "迁移身份与运行时身份分离" 列为生产前置条件（见 MASTER_PLAN 风险 R-007）。
--
-- 顺序很关键（review-10 阻塞项）：旧触发器会拒绝任何"父状态≠DRAFT"的版本更新，
-- 因此必须先替换函数并摘掉旧触发器，回填既有的非草稿版本，再挂回新触发器。
BEGIN;

ALTER TABLE "work_log_versions" ADD COLUMN IF NOT EXISTS "frozen_at" TIMESTAMPTZ(3);

CREATE OR REPLACE FUNCTION "work_log_version_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
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

  IF OLD."frozen_at" IS NOT NULL THEN
    RAISE EXCEPTION 'work log version is frozen and cannot be edited'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

-- 先摘旧触发器，才能迁移既有的非草稿版本（旧函数会直接 RAISE）。
DROP TRIGGER IF EXISTS "work_log_versions_immutable_guard" ON "work_log_versions";

UPDATE "work_log_versions" v
SET "frozen_at" = COALESCE(v."created_at", now())
WHERE v."frozen_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "work_logs" w
    WHERE w."id" = v."work_log_id" AND w."status" <> 'DRAFT'
  );

CREATE TRIGGER "work_log_versions_immutable_guard"
BEFORE UPDATE OR DELETE ON "work_log_versions"
FOR EACH ROW EXECUTE FUNCTION "work_log_version_immutable_guard"();

-- 数据库兜底：工作日志一旦离开 DRAFT，当前版本立即冻结（不依赖应用是否记得写冻结标记）。
CREATE OR REPLACE FUNCTION "work_log_freeze_on_submit"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' AND NEW."status" <> 'DRAFT' THEN
    -- 冻结该日志下所有尚未冻结的版本：既覆盖当前指针，也覆盖"同一条语句顺带重指向"
    -- 留下的旧当前版本；`frozen_at IS NULL` 保证对已冻结行是幂等的（不触发 immutable guard）。
    UPDATE "work_log_versions"
    SET "frozen_at" = now()
    WHERE "work_log_id" = NEW."id" AND "frozen_at" IS NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "work_logs_freeze_on_submit" ON "work_logs";
CREATE TRIGGER "work_logs_freeze_on_submit"
AFTER UPDATE OF "status" ON "work_logs"
FOR EACH ROW EXECUTE FUNCTION "work_log_freeze_on_submit"();

CREATE OR REPLACE FUNCTION "work_log_status_insert_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'a new work log must start in DRAFT'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "work_logs_status_insert_guard" ON "work_logs";
CREATE TRIGGER "work_logs_status_insert_guard"
BEFORE INSERT ON "work_logs"
FOR EACH ROW EXECUTE FUNCTION "work_log_status_insert_guard"();

-- M2：非 DRAFT 日志既不能追加新版本，也不能把 current_version_id 指向别的版本，
-- 否则直写库可以"伪造一条版本 + 重指向"来替换已提交日志的展示内容（审批历史仍在，
-- 但用户看到的内容被换掉）。两条约束都不读父行以外的数据，也不加反向锁。
CREATE OR REPLACE FUNCTION "work_log_current_version_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."current_version_id" IS DISTINCT FROM OLD."current_version_id" THEN
    -- 只在"非草稿/非退回"状态下禁止重指向：DRAFT 正常替换当前版本，
    -- RETURNED 是 addVersion 的合法路径（插新版本并回 DRAFT）。
    IF NEW."status" NOT IN ('DRAFT', 'RETURNED') THEN
      RAISE EXCEPTION 'current version can only change while the work log is a draft'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."current_version_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "work_log_versions" v
    WHERE v."id" = NEW."current_version_id" AND v."work_log_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'work log current version must belong to the same work log'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "work_logs_current_version_guard" ON "work_logs";
CREATE TRIGGER "work_logs_current_version_guard"
BEFORE INSERT OR UPDATE OF "current_version_id" ON "work_logs"
FOR EACH ROW EXECUTE FUNCTION "work_log_current_version_guard"();

CREATE OR REPLACE FUNCTION "work_log_version_insert_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  log_status "WorkLogStatus";
BEGIN
  SELECT w."status" INTO log_status FROM "work_logs" w WHERE w."id" = NEW."work_log_id";
  -- 允许 DRAFT 追加，以及 RETURNED（退回后由作者开新草稿版本，addVersion 先插版本再回 DRAFT）。
  IF log_status IS NOT NULL AND log_status NOT IN ('DRAFT', 'RETURNED') THEN
    RAISE EXCEPTION 'a work log version may only be appended while the work log is a draft'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "work_log_versions_insert_guard" ON "work_log_versions";
CREATE TRIGGER "work_log_versions_insert_guard"
BEFORE INSERT ON "work_log_versions"
FOR EACH ROW EXECUTE FUNCTION "work_log_version_insert_guard"();

DROP TRIGGER IF EXISTS "work_log_versions_truncate_guard" ON "work_log_versions";
DROP FUNCTION IF EXISTS "work_log_versions_truncate_guard"();

COMMIT;
