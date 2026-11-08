#!/usr/bin/env bash
set -Eeuo pipefail

# 任务 13：把生产编排部署到目标机（Ubuntu 24.04 / x86_64）。
#
# 设计要点（对应 review-46 的发现）：
#  - 直接使用仓库里的 infra/compose.prod.yml：该文件的 build.context 是 `..`，
#    若复制到 releases/ 目录再构建，路径会指错，构建必失败。
#  - 每次发布用 git sha 打镜像 tag，并写一份 release.env（API_IMAGE/WEB_IMAGE/API_TOOLS_IMAGE）。
#    回滚 = 用上一个 release.env 重新 up，镜像跟着回退（镜像 tag 写死 :local 时回滚是假的）。
#  - 回滚点是 releases/<sha>/release.env 的"上一个"软链目标，首次部署写空，不会自指。
#  - 迁移用 prod 编排里 tools profile 的 api-tools 服务，命令自带 -f/--env-file。

Usage() {
  cat <<'USAGE'
Usage: deploy.sh --source <repo> [options]

Deploy the production Compose stack on this host and wait for a healthy entrypoint.

Required:
  --source <path>        Repository checkout containing infra/

Options:
  --deploy-root <path>   Deploy root (default: /opt/project-operations)
  --env-file <path>      Production env file (default: <deploy-root>/shared/env/prod.env)
  --skip-build           Reuse existing images instead of rebuilding
  --skip-migrate         Do not run database migrations
  --dry-run              Print the commands instead of running them
  --help                 Show this help

Example:
  sudo ./infra/scripts/deploy.sh --source /srv/Management-System
USAGE
}

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] 错误: %s\n' "$*" >&2; exit 1; }

SOURCE=""
DEPLOY_ROOT="/opt/project-operations"
ENV_FILE=""
SKIP_BUILD=0
SKIP_MIGRATE=0
DRY_RUN=0

while (($# > 0)); do
  case "$1" in
    --help|-h) Usage; exit 0 ;;
    --source) SOURCE="${2:?--source 需要路径}"; shift 2 ;;
    --deploy-root) DEPLOY_ROOT="${2:?--deploy-root 需要路径}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file 需要路径}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-migrate) SKIP_MIGRATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -n "$SOURCE" ]] || { Usage; die "必须提供 --source"; }
[[ -d "$SOURCE/infra" ]] || die "找不到 $SOURCE/infra"
[[ -f "$SOURCE/infra/compose.prod.yml" ]] || die "缺少 infra/compose.prod.yml"
[[ "$(uname -s)" == "Linux" ]] || die "部署脚本只在 Linux 目标机上运行"
[[ "$(uname -m)" == "x86_64" ]] || log "警告: 目标是 $(uname -m)，需确认镜像架构"

command -v docker >/dev/null || die "缺少 docker"
docker compose version >/dev/null 2>&1 || die "缺少 docker compose v2"

# sudo 下访问 git 仓库会遇到 dubious ownership，先登记信任再取 sha，取不到就中止。
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$SOURCE" ||
  git config --global --add safe.directory "$SOURCE" 2>/dev/null || true
SHA="$(git -C "$SOURCE" rev-parse --short HEAD 2>/dev/null)" || die "无法读取 $SOURCE 的 git 提交"
[[ -n "$SHA" ]] || die "无法读取提交号"

ENV_FILE="${ENV_FILE:-$DEPLOY_ROOT/shared/env/prod.env}"
[[ -f "$ENV_FILE" ]] || die "缺少生产环境变量文件 $ENV_FILE（从 infra/env/prod.env.example 复制并填入密钥绝对路径）"

# 生产密钥必须存在且只对 root/运行组可读（见 infra/README.md）。
for key in POSTGRES_PASSWORD_FILE MFA_SECRET_KEY_FILE; do
  path="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -1)"
  [[ -n "$path" ]] || die "$ENV_FILE 缺少 $key"
  [[ -f "$path" ]] || die "$key 指向的文件不存在: $path"
  mode="$(stat -c '%a' "$path")"
  [[ "$mode" == "440" || "$mode" == "400" ]] || die "$path 权限是 $mode，应为 root:10001:440"
done

RELEASE_DIR="$DEPLOY_ROOT/releases/$SHA"
COMPOSE=(docker compose -f "$SOURCE/infra/compose.prod.yml" --env-file "$ENV_FILE")

run() {
  if ((DRY_RUN)); then
    printf '[deploy][dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# 本次发布使用的镜像 tag：与提交绑定，回滚时才能真正换回旧镜像。
export API_IMAGE="project-operations-api:$SHA"
export WEB_IMAGE="project-operations-web:$SHA"
export API_TOOLS_IMAGE="project-operations-api-tools:$SHA"

log "仓库 $SOURCE 提交 $SHA"

run install -d -m 755 "$DEPLOY_ROOT/releases" "$DEPLOY_ROOT/shared/env" "$DEPLOY_ROOT/shared/secrets"
run install -d -m 755 "$RELEASE_DIR"

if ((SKIP_BUILD)); then
  log "跳过镜像构建（复用现有 tag）"
else
  log "构建镜像 api/web/api-tools:$SHA"
  run "${COMPOSE[@]}" --profile application --profile tools build
fi

if ((SKIP_MIGRATE)); then
  log "跳数据库迁移"
else
  log "执行数据库迁移"
  run "${COMPOSE[@]}" --profile tools run --rm api-tools pnpm db:migrate:deploy
fi

log "启动应用并等待健康检查"
run "${COMPOSE[@]}" --profile application up -d

if ((DRY_RUN)); then
  log "dry-run 结束（未切换 current）"
  exit 0
fi

PORT="$(sed -n 's/^APP_HTTP_PORT=//p' "$ENV_FILE" | tail -1)"
PORT="${PORT:-8080}"

api_up=0
web_up=0
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/v1/health" 2>/dev/null; then api_up=1; fi
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/login" 2>/dev/null; then web_up=1; fi
  ((api_up == 1 && web_up == 1)) && break
  sleep 2
done

if ((api_up != 1 || web_up != 1)); then
  "${COMPOSE[@]}" --profile application ps || true
  die "健康检查超时（api=${api_up} web=${web_up}）：看 docker compose logs api web caddy"
fi

# 记录发布并维护回滚点：current 指向本次，.previous 指向本次之前的那次。
previous=""
if [[ -L "$DEPLOY_ROOT/current" ]]; then
  previous="$(readlink "$DEPLOY_ROOT/current")"
fi
if [[ -z "$previous" || "$previous" == "$RELEASE_DIR" ]]; then
  # 首次部署或同 sha 重跑：保留原有回滚点，不要把它覆盖成自己。
  [[ -f "$DEPLOY_ROOT/releases/.previous" ]] && previous="$(cat "$DEPLOY_ROOT/releases/.previous")" || previous=""
else
  printf '%s\n' "$previous" > "$DEPLOY_ROOT/releases/.previous"
fi

printf 'API_IMAGE=%s\nWEB_IMAGE=%s\nAPI_TOOLS_IMAGE=%s\n' \
  "$API_IMAGE" "$WEB_IMAGE" "$API_TOOLS_IMAGE" > "$RELEASE_DIR/release.env"
chmod 644 "$RELEASE_DIR/release.env"
printf 'SOURCE=%s\nSHA=%s\n' "$SOURCE" "$SHA" > "$RELEASE_DIR/source.env"
chmod 644 "$RELEASE_DIR/source.env"
ln -sfn "$RELEASE_DIR" "$DEPLOY_ROOT/current"

log "部署完成：$RELEASE_DIR"
log "健康检查：http://127.0.0.1:${PORT}/api/v1/health"
log "回滚目标：${previous:-无（首次部署）}"
log "回滚命令：infra/scripts/rollback.sh --deploy-root $DEPLOY_ROOT"
