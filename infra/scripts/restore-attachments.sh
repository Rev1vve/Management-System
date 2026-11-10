#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage: restore-attachments.sh [options] BACKUP_FILE

Replace the attachment volume from a validated backup archive. This destructive
operation requires CONFIRM_ATTACHMENTS_RESTORE=YES.
USAGE
  common_usage
}

positional=()
while (($# > 0)); do
  case "$1" in
    --help)
      usage
      exit 0
      ;;
    --*)
      parse_common_option "$@"
      (( PARSED_OPTION_COUNT > 0 )) || die "unknown option: $1"
      shift "$PARSED_OPTION_COUNT"
      ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done

(( ${#positional[@]} == 1 )) || die "BACKUP_FILE is required"
backup_file="${positional[0]}"
[[ "${CONFIRM_ATTACHMENTS_RESTORE:-NO}" == "YES" ]] || \
  die "set CONFIRM_ATTACHMENTS_RESTORE=YES to replace the attachment volume"

# 整卷替换不可逆：项目身份必须是显式给的（--project-name 或 COMPOSE_PROJECT_NAME），
# 不能只靠 env 文件插值——env 文件里那行缺失时会静默落到生产项目。
[[ -n "${PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-}}" ]] || \
  die "refusing to replace attachments without an explicit --project-name (or COMPOSE_PROJECT_NAME)"
if [[ "${RESTORE_ALLOW_PRODUCTION:-NO}" != "YES" ]]; then
  case "${PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-}}" in
    *prod*) die "refusing to replace attachments of a production-like project; set RESTORE_ALLOW_PRODUCTION=YES if this is intentional" ;;
  esac
fi
trap close_backup_snapshot EXIT
open_verified_backup_snapshot "$backup_file"
validate_attachment_archive "/proc/self/fd/${BACKUP_VALIDATION_FD}"
exec {BACKUP_VALIDATION_FD}<&-
BACKUP_VALIDATION_FD=""
load_compose_context

log "restoring attachment volume from validated archive"
compose --profile maintenance run --rm --no-deps -T attachments-maintenance \
  sh -eu -c '
    staging="$(mktemp -d /srv/attachments/.infra-restore.XXXXXX)"
    cleanup() { rm -rf "$staging"; }
    trap cleanup EXIT
    tar -xzf - -C "$staging"
    unsafe_entry="$(find "$staging" -mindepth 1 ! -type d ! -type f -print -quit)"
    if [ -n "$unsafe_entry" ]; then
      echo "UNSAFE_ATTACHMENT_ENTRY" >&2
      exit 1
    fi
    find "$staging" -type d -exec chown 10001:10001 {} +
    find "$staging" -type d -exec chmod 0700 {} +
    find "$staging" -type f -exec chown 10001:10001 {} +
    find "$staging" -type f -exec chmod 0600 {} +
    find /srv/attachments -mindepth 1 -maxdepth 1 ! -path "$staging" -exec rm -rf -- {} \;
    find "$staging" -mindepth 1 -maxdepth 1 -exec mv -- {} /srv/attachments/ \;
    rmdir "$staging"
    trap - EXIT
  ' <&"$BACKUP_SNAPSHOT_FD"

close_backup_snapshot
trap - EXIT
printf 'attachment_restore=PASS\n'
