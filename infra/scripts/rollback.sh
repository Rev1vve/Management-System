#!/usr/bin/env bash
set -Eeuo pipefail

# 任务 13：用上一个发布快照回滚（只回滚镜像与编排，不回滚数据库迁移）。
#
# 数据库迁移无法自动回滚：跨版本回滚前必须先确认迁移向后兼容，
# 否则旧镜像会看到它不认识的表结构。

Usage() {
  cat <<'USAGE'
Usage: rollback.sh [options]

Redeploy the previous release recorded by deploy.sh.

Options:
  --deploy-root <path>   Deploy root (default: /opt/project-operations)
  --source <path>        Repository checkout (default: the one recorded in the release)
  --env-file <path>      Production env file (default: <deploy-root>/shared/env/prod.env)
  --dry-run              Print the commands instead of running them
  --help                 Show this help

Example:
  sudo ./infra/scripts/rollback.sh
USAGE
}

log() { printf '[rollback] %s\n' "$*"; }
die() { printf '[rollback] 错误: %s\n' "$*" >&2; exit 1; }

DEPLOY_ROOT="/opt/project-operations"
SOURCE=""
ENV_FILE=""
DRY_RUN=0

while (($# > 0)); do
  case "$1" in
    --help|-h) Usage; exit 0 ;;
    --deploy-root) DEPLOY_ROOT="${2:?--deploy-root 需要路径}"; shift 2 ;;
    --source) SOURCE="${2:?--source 需要路径}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file 需要路径}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -f "$DEPLOY_ROOT/releases/.previous" ]] || die "没有记录回滚点（$DEPLOY_ROOT/releases/.previous 不存在）"
PREVIOUS="$(cat "$DEPLOY_ROOT/releases/.previous")"
[[ -n "$PREVIOUS" ]] || die "回滚点为空：这是首次部署"
[[ -d "$PREVIOUS" ]] || die "回滚目标目录不存在: $PREVIOUS"
[[ -f "$PREVIOUS/release.env" ]] || die "回滚目标缺少 release.env: $PREVIOUS"

ENV_FILE="${ENV_FILE:-$DEPLOY_ROOT/shared/env/prod.env}"
[[ -f "$ENV_FILE" ]] || die "缺少环境变量文件: $ENV_FILE"

SOURCE="${SOURCE:-$(sed -n 's/^SOURCE=//p' "$PREVIOUS/source.env" 2>/dev/null | tail -1)}"
[[ -n "$SOURCE" && -f "$SOURCE/infra/compose.prod.yml" ]] ||
  die "需要 --source 指向包含 infra/compose.prod.yml 的仓库"

run() {
  if ((DRY_RUN)); then
    printf '[rollback][dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# shellcheck disable=SC1090
set -a; source "$PREVIOUS/release.env"; set +a
log "回滚到 $PREVIOUS（API_IMAGE=$API_IMAGE）"

COMPOSE=(docker compose -f "$SOURCE/infra/compose.prod.yml" --env-file "$ENV_FILE")
run "${COMPOSE[@]}" --profile application up -d

if ((DRY_RUN)); then
  log "dry-run 结束（未切换 current）"
  exit 0
fi

PORT="$(sed -n 's/^APP_HTTP_PORT=//p' "$ENV_FILE" | tail -1)"
PORT="${PORT:-8080}"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/v1/health" 2>/dev/null; then
    ln -sfn "$PREVIOUS" "$DEPLOY_ROOT/current"
    rm -f "$DEPLOY_ROOT/releases/.previous"
    log "回滚完成：current → $PREVIOUS"
    log "注意：数据库迁移未回滚，确认旧镜像兼容当前表结构"
    exit 0
  fi
  sleep 2
done

die "回滚后健康检查未通过，请检查 docker compose logs"
