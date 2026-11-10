#!/usr/bin/env bash
set -Eeuo pipefail

# 安装外接盘副本定时器：与备份定时器同构，但目标必须是一块已挂载的外接盘。
#
# 与备份安装器的关键差别：这里的挂载点必须由操作者显式给出并当场校验，
# 因为"挂载点不存在"时若悄悄回落到系统盘，就等于没有异机副本。

Usage() {
  cat <<'USAGE'
Usage: install-offsite-timer.sh --target DIR [options]

Install and enable the daily offsite copy timer.

Required:
  --target DIR           Mount point of the external disk (must be a mount point now)

Options:
  --repo <path>          Repository checkout (default: the one containing this script)
  --source DIR           Backup root to copy (default: /opt/project-operations/backups/scheduled)
  --keep-runs N          Keep the newest N runs on the external disk (default: 14)
  --age-recipient FILE   Encrypt copied dumps with age (recommended)
  --dry-run              Print actions without changing the system
  --help                 Show this help

Example:
  sudo ./infra/scripts/install-offsite-timer.sh --target /media/jc/BACKUP
USAGE
}

log() { printf '[offsite-timer] %s\n' "$*"; }
die() { printf '[offsite-timer] 错误: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

TARGET_DIR=""
SOURCE_DIR="/opt/project-operations/backups/scheduled"
KEEP_RUNS=14
AGE_RECIPIENT=""
DRY_RUN=0

while (($# > 0)); do
  case "$1" in
    --help|-h) Usage; exit 0 ;;
    --target) TARGET_DIR="${2:?--target 需要路径}"; shift 2 ;;
    --repo) REPO="${2:?--repo 需要路径}"; shift 2 ;;
    --source) SOURCE_DIR="${2:?--source 需要路径}"; shift 2 ;;
    --keep-runs) KEEP_RUNS="${2:?--keep-runs 需要数字}"; shift 2 ;;
    --age-recipient) AGE_RECIPIENT="${2:?--age-recipient 需要文件}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "未知参数: $1" ;;
  esac
done

run() {
  if ((DRY_RUN)); then
    printf '[offsite-timer][dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "需要 root：用 sudo 执行"
[[ -n "$TARGET_DIR" ]] || { Usage; die "必须提供 --target（外接盘挂载点）"; }
[[ -d "$TARGET_DIR" ]] || die "目标目录不存在: $TARGET_DIR"
[[ -d "$SOURCE_DIR" ]] || die "备份源目录不存在: $SOURCE_DIR"

# 挂载点校验：外接盘没挂上时，这个目录通常只是系统盘上的普通目录。
if ! mountpoint -q "$TARGET_DIR" 2>/dev/null; then
  die "$TARGET_DIR 不是挂载点：外接盘可能没插好/没挂载。拒绝安装（否则会复制到系统盘）"
fi
if [[ "$(stat -c %d -- "$SOURCE_DIR")" == "$(stat -c %d -- "$TARGET_DIR")" ]]; then
  die "源与目标在同一设备：这不是异介质副本"
fi

[[ -x "$REPO/infra/scripts/backup-offsite.sh" ]] || die "缺少 backup-offsite.sh"
[[ -f "$REPO/infra/systemd/project-operations-offsite" ]] || die "缺少 systemd 包装脚本"

if systemctl is-active --quiet project-operations-offsite.service 2>/dev/null; then
  die "副本任务正在运行，请稍后再安装"
fi

UNITS=(/usr/local/sbin/project-operations-offsite
  /etc/systemd/system/project-operations-offsite.service
  /etc/systemd/system/project-operations-offsite.timer)
DROPIN_DIR=/etc/systemd/system/project-operations-offsite.service.d
DROPIN="$DROPIN_DIR/10-paths.conf"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/opt/project-operations/backups/offsite-install-$stamp"
if ((!DRY_RUN)); then
  install -d -m 0700 /opt/project-operations/backups "$backup_dir"
fi
for existing in "${UNITS[@]}" "$DROPIN"; do
  [[ -e "$existing" ]] || continue
  run cp -p -- "$existing" "$backup_dir/$(basename "$existing")"
done

run install -m 0750 -o root -g root "$REPO/infra/systemd/project-operations-offsite" "${UNITS[0]}"
run install -m 0644 -o root -g root "$REPO/infra/systemd/project-operations-offsite.service" "${UNITS[1]}"
run install -m 0644 -o root -g root "$REPO/infra/systemd/project-operations-offsite.timer" "${UNITS[2]}"

run install -d -m 0755 "$DROPIN_DIR"
if ((DRY_RUN)); then
  printf '[offsite-timer][dry-run] write %s (TARGET_DIR=%s)\n' "$DROPIN" "$TARGET_DIR"
else
  {
    echo '[Service]'
    echo "Environment=SOURCE_DIR=$SOURCE_DIR"
    echo "Environment=TARGET_DIR=$TARGET_DIR"
    echo "Environment=KEEP_RUNS=$KEEP_RUNS"
    echo "Environment=SCRIPTS_DIR=$REPO/infra/scripts"
    [[ -n "$AGE_RECIPIENT" ]] && echo "Environment=AGE_RECIPIENT=$AGE_RECIPIENT"
    # 挂载点可能按 tailnet/机器变化：用 drop-in 覆盖 ConditionPathIsMountPoint。
    echo "ConditionPathIsMountPoint=$TARGET_DIR"
  } > "$DROPIN"
  chmod 0644 "$DROPIN"
fi

run systemctl daemon-reload

if ((!DRY_RUN)); then
  applied="$(systemctl show project-operations-offsite.service -p Environment)"
  grep -q "TARGET_DIR=$TARGET_DIR" <<<"$applied" || die "drop-in 未生效：$applied"
  log "已确认单元环境：$applied"
fi

if ((DRY_RUN)); then
  log "dry-run：跳过首次运行"
else
  log "先跑一次副本，确认能成功"
  if ! systemctl start project-operations-offsite.service; then
    journalctl -u project-operations-offsite.service -n 60 --no-pager || true
    die "首次副本失败，未启用定时器"
  fi
fi

run systemctl enable --now project-operations-offsite.timer

if ((DRY_RUN)); then
  log "dry-run 结束"
  exit 0
fi

systemctl show project-operations-offsite.service -p Result -p ExecMainStatus
systemctl list-timers project-operations-offsite.timer --all --no-pager
log "完成：每天 03:30 Australia/Melbourne 把当日备份复制到 $TARGET_DIR"
