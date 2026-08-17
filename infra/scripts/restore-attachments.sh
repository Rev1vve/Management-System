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
    find /srv/attachments -mindepth 1 -maxdepth 1 ! -path "$staging" -exec rm -rf -- {} \;
    find "$staging" -mindepth 1 -maxdepth 1 -exec mv -- {} /srv/attachments/ \;
    rmdir "$staging"
    trap - EXIT
  ' <&"$BACKUP_SNAPSHOT_FD"

close_backup_snapshot
trap - EXIT
printf 'attachment_restore=PASS\n'
