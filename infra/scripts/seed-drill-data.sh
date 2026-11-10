#!/usr/bin/env bash
set -Eeuo pipefail

# 任务 13：给演练栈灌入真实量级的合成数据，让 RTO 数字有意义。
#
# 为什么需要它：生产库是空的，空库恢复 0.668 秒说明不了任何问题。
# 造一批可控规模的数据（默认 200 用户 / 100 项目 / 20000 条工作日志），
# 再备份→恢复，得到的耗时才可以外推到真实数据量。
#
# 只在演练项目里运行：拒绝没有显式 --project-name 的调用，拒绝名字不含 verify 的项目。

Usage() {
  cat <<'USAGE'
Usage: seed-drill-data.sh --project-name NAME --env-file FILE [options]

Fill a throwaway drill stack with synthetic business data so restore timings mean something.

Required:
  --project-name NAME   Compose project of the drill stack (must contain "verify")
  --env-file FILE       Env file of the drill stack

Options:
  --users N             Synthetic users (default: 200)
  --projects N          Synthetic projects (default: 100)
  --work-logs N         Synthetic work logs with versions (default: 20000)
  --marker NAME         Number prefix for generated rows (default: DRILL)
  --compose-file FILE   Compose file (default: infra/compose.prod.yml)
  --help                Show this help

Example:
  sudo ./infra/scripts/seed-drill-data.sh \
    --project-name project-operations-verify \
    --env-file /opt/project-operations/shared/env/drill.env
USAGE
}

log() { printf '[seed] %s\n' "$*"; }
die() { printf '[seed] 错误: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

USERS=200
PROJECTS=100
WORK_LOGS=20000
MARKER=DRILL

PARSED_OPTION_COUNT=0
while (($# > 0)); do
  case "$1" in
    --help|-h) Usage; exit 0 ;;
    --users) USERS="${2:?--users 需要数字}"; shift 2 ;;
    --projects) PROJECTS="${2:?--projects 需要数字}"; shift 2 ;;
    --work-logs) WORK_LOGS="${2:?--work-logs 需要数字}"; shift 2 ;;
    --marker) MARKER="${2:?--marker 需要名称}"; shift 2 ;;
    *)
      parse_common_option "$@"
      (( PARSED_OPTION_COUNT > 0 )) || die "unknown option: $1"
      shift "$PARSED_OPTION_COUNT"
      ;;
  esac
done

for value in "$USERS" "$PROJECTS" "$WORK_LOGS"; do
  [[ "$value" =~ ^[0-9]+$ ]] || die "数量必须是整数: $value"
done
[[ "$MARKER" =~ ^[A-Za-z][A-Za-z0-9_-]{0,15}$ ]] || die "marker 只允许字母开头的短标识: $MARKER"

# 双保险：项目身份必须显式给出，且必须是演练项目。
[[ -n "${PROJECT_NAME:-}" ]] || die "必须提供 --project-name（演练栈的名字），拒绝在生产项目上灌数据"
[[ "$PROJECT_NAME" == *verify* ]] || die "拒绝在非演练项目上灌数据：$PROJECT_NAME"

load_compose_context
postgres_container_id >/dev/null
wait_for_postgres

log "向 $PROJECT_NAME 写入合成数据：users=$USERS projects=$PROJECTS work_logs=$WORK_LOGS marker=$MARKER"

# 用 generate_series 一次性生成，直接在数据库端完成，避免往返。
# 工作日志从 DRAFT 起步并挂上版本，符合数据库守卫（0007/0013 迁移）的要求。
compose exec --no-TTY postgres psql \
  --username "$(postgres_env POSTGRES_USER)" \
  --dbname "$(postgres_env POSTGRES_DB)" \
  --set=ON_ERROR_STOP=1 \
  --set=seed_users="$USERS" \
  --set=seed_projects="$PROJECTS" \
  --set=seed_logs="$WORK_LOGS" \
  --set=seed_marker="$MARKER" <<'SQL'
BEGIN;

-- 1) 用户
INSERT INTO users (id, account, name, work_email, status, mfa_enabled, created_at, updated_at)
SELECT gen_random_uuid(),
       :'seed_marker' || '-u' || i,
       :'seed_marker' || ' 用户 ' || i,
       lower(:'seed_marker') || '-u' || i || '@drill.invalid',
       'ACTIVE',
       false,
       now(),
       now()
FROM generate_series(1, :seed_users) AS i
ON CONFLICT (account) DO NOTHING;

-- 2) 项目
INSERT INTO projects (id, number, name, status, completion_percent, version, created_at, updated_at)
SELECT gen_random_uuid(),
       :'seed_marker' || '-P' || i,
       :'seed_marker' || ' 项目 ' || i,
       'ACTIVE',
       (i % 100),
       1,
       now(),
       now()
FROM generate_series(1, :seed_projects) AS i
ON CONFLICT (number) DO NOTHING;

-- 3) 工作日志（先建 DRAFT，再挂版本；提交留到最后）
WITH authors AS (
  SELECT id, row_number() OVER (ORDER BY account) AS rn FROM users WHERE account LIKE :'seed_marker' || '-u%'
), projects_seed AS (
  SELECT id, row_number() OVER (ORDER BY number) AS rn FROM projects WHERE number LIKE :'seed_marker' || '-P%'
), generated AS (
  SELECT gen_random_uuid() AS log_id,
         i,
         (SELECT id FROM authors a WHERE a.rn = (i % (SELECT count(*) FROM authors)) + 1) AS author_id,
         (SELECT id FROM projects_seed p WHERE p.rn = (i % (SELECT count(*) FROM projects_seed)) + 1) AS project_id
  FROM generate_series(1, :seed_logs) AS i
)
INSERT INTO work_logs (id, number, author_id, project_id, status, visibility, version, created_at, updated_at)
SELECT log_id,
       :'seed_marker' || '-WL' || i,
       author_id,
       project_id,
       'DRAFT',
       'PRIVATE',
       1,
       now(),
       now()
FROM generated
ON CONFLICT (number) DO NOTHING;

WITH logs_seed AS (
  SELECT id, row_number() OVER (ORDER BY number) AS rn
  FROM work_logs WHERE number LIKE :'seed_marker' || '-WL%'
)
INSERT INTO work_log_versions
  (id, work_log_id, version_number, work_date, hours, completion, submitted_by_id, submitted_at)
SELECT gen_random_uuid(),
       l.id,
       1,
       DATE '2026-01-01' + ((l.rn % 300))::int,
       ((l.rn % 8) + 1)::numeric(6, 2),
       '合成数据：用于恢复演练计时',
       w.author_id,
       now()
FROM logs_seed l
JOIN work_logs w ON w.id = l.id
WHERE NOT EXISTS (SELECT 1 FROM work_log_versions v WHERE v.work_log_id = l.id);

UPDATE work_logs w
SET current_version_id = v.id
FROM work_log_versions v
WHERE v.work_log_id = w.id
  AND w.number LIKE :'seed_marker' || '-WL%'
  AND w.current_version_id IS NULL;

COMMIT;
SQL

log "写入完成。当前计数："
compose exec --no-TTY postgres psql \
  --username "$(postgres_env POSTGRES_USER)" \
  --dbname "$(postgres_env POSTGRES_DB)" \
  --tuples-only --no-align --command \
  "select 'users=' || (select count(*) from users where account like '${MARKER}-u%')
      || ' projects=' || (select count(*) from projects where number like '${MARKER}-P%')
      || ' work_logs=' || (select count(*) from work_logs where number like '${MARKER}-WL%')
      || ' versions=' || (select count(*) from work_log_versions);"

log "下一步：跑一次备份，再按 RESTORE-DRILL.md 计时恢复，得到有数据量的 RTO"
