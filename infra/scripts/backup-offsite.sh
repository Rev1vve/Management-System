#!/usr/bin/env bash
set -Eeuo pipefail

# 任务 13：把已生成的备份复制到外接盘（异机/异介质副本）。
#
# 为什么不能只靠这台机器上的 backups/：数据盘和备份在同一块 nvme 上，
# 盘坏、误删、勒索加密都会把两份一起带走。
#
# 设计要点：
#  - 拒绝源与目标在同一设备（stat 的设备号相同），否则等于没复制；
#  - 复制后逐个 `sha256sum -c` 校验，校验不过就不写 .ok 标记；
#  - 目标端按 <hostname>/<run-id>/ 存放，同一台机器多次迁移不互相覆盖；
#  - 已复制过的运行目录跳过（.ok 标记存在），可反复执行；
#  - 可选 age 加密：外接盘/U 盘会丢、会被借走，明文数据库不该躺在上面。

Usage() {
  cat <<'USAGE'
Usage: backup-offsite.sh --source DIR --target DIR [options]

Copy scheduled backup runs to an external disk and verify every checksum.

Required:
  --source DIR           Backup root, e.g. /opt/project-operations/backups/scheduled
  --target DIR           Mount point of the external disk

Options:
  --age-recipient FILE   Encrypt with age using this recipient file (recommended for USB disks)
  --keep-runs N          Keep only the newest N runs on the target (default: keep all)
  --dry-run              Report what would be copied
  --help                 Show this help

Example:
  sudo ./infra/scripts/backup-offsite.sh \
    --source /opt/project-operations/backups/scheduled \
    --target /media/jc/BACKUP
USAGE
}

log() { printf '[offsite] %s\n' "$*"; }
die() { printf '[offsite] 错误: %s\n' "$*" >&2; exit 1; }

SOURCE=""
TARGET=""
AGE_RECIPIENT=""
KEEP_RUNS=""
DRY_RUN=0

while (($# > 0)); do
  case "$1" in
    --help|-h) Usage; exit 0 ;;
    --source) SOURCE="${2:?--source 需要目录}"; shift 2 ;;
    --target) TARGET="${2:?--target 需要目录}"; shift 2 ;;
    --age-recipient) AGE_RECIPIENT="${2:?--age-recipient 需要文件}"; shift 2 ;;
    --keep-runs) KEEP_RUNS="${2:?--keep-runs 需要数字}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -n "$SOURCE" && -n "$TARGET" ]] || { Usage; die "必须提供 --source 与 --target"; }
[[ -d "$SOURCE" ]] || die "源目录不存在: $SOURCE"
[[ -d "$TARGET" ]] || die "目标目录不存在（外接盘没挂上？）: $TARGET"
[[ -z "$KEEP_RUNS" || "$KEEP_RUNS" =~ ^[0-9]+$ ]] || die "--keep-runs 必须是整数"

if [[ -n "$AGE_RECIPIENT" ]]; then
  command -v age >/dev/null || die "指定了 --age-recipient 但没装 age（apt install age）"
  [[ -f "$AGE_RECIPIENT" ]] || die "找不到 age 接收者文件: $AGE_RECIPIENT"
fi

# 关键检查：源与目标必须在不同设备上，否则"异介质"是假象。
source_dev="$(stat -c %d -- "$SOURCE")"
target_dev="$(stat -c %d -- "$TARGET")"
if [[ "$source_dev" == "$target_dev" ]]; then
  die "源与目标在同一设备（dev=$source_dev）：这不算异机副本，请确认外接盘已挂载"
fi

host="$(hostname -s 2>/dev/null || hostname)"
dest_root="$TARGET/project-operations/$host"

log "源 $SOURCE（dev=$source_dev）→ 目标 $dest_root（dev=$target_dev）"

shopt -s nullglob
runs=()
for dir in "$SOURCE"/*/; do
  [[ "$(basename "$dir")" =~ ^[0-9]{8}T[0-9]{6}Z- ]] && runs+=("$dir")
done
shopt -u nullglob

((${#runs[@]} > 0)) || { log "源里没有运行目录，结束"; exit 0; }

IFS=$'\n' sorted=($(printf '%s\n' "${runs[@]}" | sort))
unset IFS

copied=0
skipped=0
failed=0

for dir in "${sorted[@]}"; do
  name="$(basename "$dir")"
  # 只复制已完成的运行：有 SUCCESS 标记才值得带到异机。
  if [[ ! -f "$dir/SUCCESS" ]]; then
    log "跳过未完成/失败的运行：$name"
    skipped=$((skipped + 1))
    continue
  fi

  dest="$dest_root/$name"
  if [[ -f "$dest/.ok" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  if ((DRY_RUN)); then
    log "将复制 $name → $dest"
    copied=$((copied + 1))
    continue
  fi

  install -d -m 0700 "$dest"
  if ! cp -p -- "$dir"/* "$dest"/; then
    log "复制失败：$name"
    failed=$((failed + 1))
    rm -rf -- "$dest"
    continue
  fi

  # 校验：逐个 sidecar 校验；不通过就删除副本，绝不留"看起来成功"的目录。
  if ! (cd "$dest" && shopt -s nullglob && sha256sum --check -- *.sha256); then
    log "校验失败，已删除副本：$name"
    rm -rf -- "$dest"
    failed=$((failed + 1))
    continue
  fi

  if [[ -n "$AGE_RECIPIENT" ]]; then
    # 加密后删明文：外接盘丢失时不应泄露数据库内容。
    for plain in "$dest"/*.dump "$dest"/*.tar.gz; do
      [[ -e "$plain" ]] || continue
      age --encrypt --recipients-file "$AGE_RECIPIENT" --output "${plain}.age" "$plain" ||
        { log "加密失败：$plain"; failed=$((failed + 1)); }
      rm -f -- "$plain"
    done
  fi

  date -u +%FT%TZ > "$dest/.ok"
  log "已复制并校验：$name"
  copied=$((copied + 1))
done

# 目标端保留策略（可选）：只影响外接盘，不动本机备份。
if [[ -n "$KEEP_RUNS" ]] && ((KEEP_RUNS > 0)) && ((DRY_RUN == 0)); then
  mapfile -t existing < <(find "$dest_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
  excess=$(( ${#existing[@]} - KEEP_RUNS ))
  if ((excess > 0)); then
    for ((i = 0; i < excess; i++)); do
      log "目标端删除旧副本：${existing[i]}"
      rm -rf -- "${dest_root:?}/${existing[i]}"
    done
  fi
fi

if ((DRY_RUN)); then
  log "dry-run：将复制 $copied，跳过 $skipped"
else
  log "完成：复制 $copied，跳过 $skipped，失败 $failed"
fi

sync
((failed == 0)) || exit 1
