#!/usr/bin/env bash
set -Eeuo pipefail

# 安装每日备份定时器：把 infra/systemd/ 下的三个单元装到系统位置，
# 先真实跑一次备份，成功后才启用定时器（避免"定时器装好了但从来没成功过"）。

Usage() {
  cat <<'USAGE'
Usage: install-backup-timer.sh [options]

Install and enable the daily backup timer for the production stack.

Options:
  --repo <path>          Repository checkout (default: the one containing this script)
  --env-file <path>      Production env file (default: /opt/project-operations/shared/env/prod.env)
  --skip-first-run       Install units but do not run a backup before enabling
  --dry-run              Print the actions instead of performing them
  --help                 Show this help

Example:
  sudo /srv/Management-System/infra/scripts/install-backup-timer.sh
USAGE
}

log() { printf '[timer] %s\n' "$*"; }
die() { printf '[timer] 错误: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="/opt/project-operations/shared/env/prod.env"
SKIP_FIRST_RUN=0
DRY_RUN=0

while (($# > 0)); do
  case "$1" in
    --help|-h) Usage; exit 0 ;;
    --repo) REPO="${2:?--repo 需要路径}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file 需要路径}"; shift 2 ;;
    --skip-first-run) SKIP_FIRST_RUN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "未知参数: $1" ;;
  esac
done

run() {
  if ((DRY_RUN)); then
    printf '[timer][dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "需要 root：用 sudo 执行"
[[ -f "$REPO/infra/systemd/project-operations-backup" ]] || die "缺少 $REPO/infra/systemd/project-operations-backup"
[[ -f "$ENV_FILE" ]] || die "缺少生产 env：$ENV_FILE"
command -v docker >/dev/null || die "缺少 docker"
command -v flock >/dev/null || die "缺少 flock"

if systemctl is-active --quiet project-operations-backup.service 2>/dev/null; then
  die "备份任务正在运行，请等它结束后再安装"
fi

for script in backup.sh backup-attachments.sh; do
  [[ -x "$REPO/infra/scripts/$script" ]] || die "缺少可执行脚本：$REPO/infra/scripts/$script"
done

UNITS=(/usr/local/sbin/project-operations-backup
  /etc/systemd/system/project-operations-backup.service
  /etc/systemd/system/project-operations-backup.timer)

# 已有同名文件先备份，便于对比/回退。
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/opt/project-operations/backups/timer-install-$stamp"
if ((!DRY_RUN)); then
  install -d -m 0700 /opt/project-operations/backups "$backup_dir"
fi
for existing in "${UNITS[@]}"; do
  [[ -e "$existing" ]] || continue
  run cp -p -- "$existing" "$backup_dir/$(basename "$existing")"
done

run install -m 0750 -o root -g root "$REPO/infra/systemd/project-operations-backup" "${UNITS[0]}"
run install -m 0644 -o root -g root "$REPO/infra/systemd/project-operations-backup.service" "${UNITS[1]}"
run install -m 0644 -o root -g root "$REPO/infra/systemd/project-operations-backup.timer" "${UNITS[2]}"

# systemd 不会继承调用者环境：路径必须写进 drop-in，否则 --repo/--env-file 运行期失效，
# 首次校验跑的会是单元脚本里的硬编码默认值。
DROPIN_DIR=/etc/systemd/system/project-operations-backup.service.d
DROPIN="$DROPIN_DIR/10-paths.conf"
run install -d -m 0755 "$DROPIN_DIR"
if [[ -e "$DROPIN" ]]; then
  run cp -p -- "$DROPIN" "$backup_dir/10-paths.conf"
fi
if ((DRY_RUN)); then
  printf '[timer][dry-run] write %s (COMPOSE_FILE=%s ENV_FILE=%s SCRIPTS_DIR=%s)\n' \
    "$DROPIN" "$REPO/infra/compose.prod.yml" "$ENV_FILE" "$REPO/infra/scripts"
else
  cat > "$DROPIN" <<UNIT_ENV
[Service]
Environment=COMPOSE_FILE=$REPO/infra/compose.prod.yml
Environment=ENV_FILE=$ENV_FILE
Environment=SCRIPTS_DIR=$REPO/infra/scripts
UNIT_ENV
  chmod 0644 "$DROPIN"
fi

run systemctl daemon-reload

if ((!DRY_RUN)); then
  applied="$(systemctl show project-operations-backup.service -p Environment)"
  grep -q "ENV_FILE=$ENV_FILE" <<<"$applied" ||
    die "drop-in 未生效：$applied"
  log "已确认单元环境：$applied"
fi

if ((SKIP_FIRST_RUN)); then
  log "跳过首次运行检查"
elif ((DRY_RUN)); then
  log "dry-run：跳过首次运行"
else
  log "先跑一次真实备份，确认能成功"
  if ! systemctl start project-operations-backup.service; then
    journalctl -u project-operations-backup.service -n 60 --no-pager || true
    die "首次备份失败，未启用定时器；先按上面的日志修好"
  fi
fi

run systemctl enable --now project-operations-backup.timer

if ((DRY_RUN)); then
  log "dry-run 结束"
  exit 0
fi

systemctl show project-operations-backup.service -p Result -p ExecMainStatus
systemctl list-timers project-operations-backup.timer --all --no-pager
log "完成：每天 03:00 Australia/Melbourne，错过会补跑一次，不自动删除旧备份"
