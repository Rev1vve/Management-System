#!/usr/bin/env bash
set -Eeuo pipefail

# 任务 13：备份保留策略。默认只演练（dry-run），加 --apply 才真的删。
#
# 安全规则（任何一条不满足就不删）：
#  1. 目标必须显式给出，且不能位于仓库内；
#  2. 只处理名字形如 <UTC时间戳>-<随机后缀> 的运行目录；
#  3. **永远保留最近一次运行**，无论它多旧——否则一次误配置就能把最后一份备份删掉；
#  4. 只保留最近一次 SUCCESS 的运行（备份失败时最后一份好数据不能被当成旧的删掉）；
#  5. 没有 SUCCESS/FAILED 标记的目录（例如中断的半成品）只在超过 --partial-days 后清理。

Usage() {
  cat <<'USAGE'
Usage: prune-backups.sh --backup-root <dir> [options]

Delete old scheduled backup runs while always keeping the newest and the newest successful one.

Required:
  --backup-root <dir>    Directory containing the scheduled run directories

Options:
  --keep-days <n>        Keep runs younger than n days (default: 14)
  --keep-last <n>        Always keep the newest n runs (default: 3)
  --partial-days <n>     Delete markerless (interrupted) runs older than n days (default: 2)
  --apply                Actually delete; without it the script only reports
  --help                 Show this help

Example:
  sudo ./infra/scripts/prune-backups.sh --backup-root /opt/project-operations/backups/scheduled --keep-days 14
USAGE
}

log() { printf '[prune] %s\n' "$*"; }
die() { printf '[prune] 错误: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BACKUP_ROOT=""
KEEP_DAYS=14
KEEP_LAST=3
PARTIAL_DAYS=2
APPLY=0

while (($# > 0)); do
  case "$1" in
    --help|-h) Usage; exit 0 ;;
    --backup-root) BACKUP_ROOT="${2:?--backup-root 需要目录}"; shift 2 ;;
    --keep-days) KEEP_DAYS="${2:?--keep-days 需要数字}"; shift 2 ;;
    --keep-last) KEEP_LAST="${2:?--keep-last 需要数字}"; shift 2 ;;
    --partial-days) PARTIAL_DAYS="${2:?--partial-days 需要数字}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -n "$BACKUP_ROOT" ]] || { Usage; die "必须提供 --backup-root"; }
[[ -d "$BACKUP_ROOT" ]] || die "目录不存在: $BACKUP_ROOT"
for value in "$KEEP_DAYS" "$KEEP_LAST" "$PARTIAL_DAYS"; do
  [[ "$value" =~ ^[0-9]+$ ]] || die "参数必须是整数: $value"
done

# 备份根不能在仓库里：避免误删源码或提交物。
# 用 cd + pwd -P 解析绝对路径：realpath 在部分环境（如 Windows 的 Git Bash）不可用。
resolved_root="$(cd -- "$BACKUP_ROOT" && pwd -P)"
resolved_repo="$(cd -- "$REPO_ROOT" && pwd -P)"
case "$resolved_root" in
  "$resolved_repo" | "$resolved_repo"/*) die "拒绝在仓库内操作: $resolved_root" ;;
esac

shopt -s nullglob
runs=()
for dir in "$resolved_root"/*/; do
  name="$(basename "$dir")"
  # 只认 <8位日期>T<6位时间>Z-<后缀> 这种运行目录名，别碰别的数据。
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z- ]] || continue
  runs+=("$dir")
done
shopt -u nullglob

if ((${#runs[@]} == 0)); then
  log "没有可处理的运行目录：$resolved_root"
  exit 0
fi

# 按名字（UTC 时间戳）排序 = 按时间排序
IFS=$'\n' sorted=($(printf '%s\n' "${runs[@]}" | sort))
unset IFS

keep=()
protected() { printf '%s\n' "${keep[@]}" | grep -qxF -- "$1"; }

# 规则 3：最近一次运行无论如何保留
keep+=("${sorted[-1]}")

# 规则 4：最近一次 SUCCESS 也保留
for ((i = ${#sorted[@]} - 1; i >= 0; i--)); do
  if [[ -f "${sorted[i]}/SUCCESS" ]]; then
    protect="${sorted[i]}"
    protected "$protect" || keep+=("$protect")
    break
  fi
done

# 规则：最近 --keep-last 个一律保留
for ((i = ${#sorted[@]} - 1; i >= 0 && ${#keep[@]} < KEEP_LAST; i--)); do
  protected "${sorted[i]}" || keep+=("${sorted[i]}")
done

now_epoch=$(date +%s)
deleted=0
kept=0
failed=0

for dir in "${sorted[@]}"; do
  name_of_dir="$(basename "$dir")"
  if protected "$dir"; then
    ((kept++)) || true
    continue
  fi

  # 年龄从目录名里的 UTC 时间戳推导：mtime 会被拷贝/恢复改掉，名字不会。
  day="${name_of_dir:0:4}-${name_of_dir:4:2}-${name_of_dir:6:2}"
  run_epoch="$(date -u -d "$day" +%s 2>/dev/null || echo "$now_epoch")"
  age_days=$(( (now_epoch - run_epoch) / 86400 ))
  if [[ -f "$dir/SUCCESS" || -f "$dir/FAILED" ]]; then
    ((age_days > KEEP_DAYS)) || { ((kept++)) || true; continue; }
    reason="超过 ${KEEP_DAYS} 天"
  else
    # 无标记 = 中断的半成品：给它 --partial-days 的取证窗口
    ((age_days > PARTIAL_DAYS)) || { ((kept++)) || true; continue; }
    reason="无标记且超过 ${PARTIAL_DAYS} 天"
  fi

  size="$(du -sh -- "$dir" 2>/dev/null | cut -f1 || true)"
  size="${size:-?}"
  if ((APPLY)); then
    if rm -rf -- "$dir"; then
      log "已删除 $dir（${size:-?}，$reason）"
      ((deleted++)) || true
    else
      log "删除失败：$dir"
      ((failed++)) || true
    fi
  else
    log "将删除 $dir（${size:-?}，$reason）"
    ((deleted++)) || true
  fi
done

mode="演练"
((APPLY)) || mode="dry-run"
log "完成（${mode}）：保留 $kept，$([[ $APPLY == 1 ]] && echo 已删 || echo 待删) $deleted，失败 $failed"
protected_names=""
for kept_dir in "${keep[@]}"; do
  protected_names="${protected_names:+$protected_names,}$(basename "$kept_dir")"
done
log "保护名单：$protected_names"

((failed == 0)) || exit 1
