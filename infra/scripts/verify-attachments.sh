#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage: verify-attachments.sh [options]

Write a temporary marker to the attachment volume, verify it from a new one-off
container, back up the volume, remove the marker, restore the archive, and verify
the exact marker content. Temporary marker and backup files are removed.
USAGE
  common_usage
}

while (($# > 0)); do
  case "$1" in
    --help)
      usage
      exit 0
      ;;
    *)
      parse_common_option "$@"
      (( PARSED_OPTION_COUNT > 0 )) || die "unknown option: $1"
      shift "$PARSED_OPTION_COUNT"
      ;;
  esac
done

load_compose_context
require_disposable_project
marker_name="infra-verify-attachment-$$_${RANDOM}.txt"
marker_value="attachment-persistence-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
backup_file=""

remove_marker() {
  compose --profile maintenance run --rm --no-deps -T attachments-maintenance \
    sh -eu -c 'rm -f -- "/srv/attachments/$1"' sh "$marker_name"
}

cleanup() {
  local cleanup_failed=0
  if ! remove_marker; then
    log "ERROR: could not remove attachment verification marker"
    cleanup_failed=1
  fi
  if [[ -n "$backup_file" && "${KEEP_VERIFY_BACKUP:-NO}" != "YES" ]]; then
    if ! rm -f -- "$backup_file" "${backup_file}.sha256"; then
      log "ERROR: could not remove attachment verification backup artifacts"
      cleanup_failed=1
    fi
  fi
  (( cleanup_failed == 0 ))
}
register_verification_cleanup cleanup

printf '%s' "$marker_value" | \
  compose --profile maintenance run --rm --no-deps -T attachments-maintenance \
    sh -eu -c 'cat > "/srv/attachments/$1"' sh "$marker_name"

persisted_value="$(
  compose --profile maintenance run --rm --no-deps -T attachments-maintenance \
    sh -eu -c 'cat -- "/srv/attachments/$1"' sh "$marker_name"
)"
[[ "$persisted_value" == "$marker_value" ]] || \
  die "attachment marker did not persist across one-off container recreation"

backup_file="$("${SCRIPT_DIR}/backup-attachments.sh" \
  --compose-file "$COMPOSE_FILE" \
  --env-file "$ENV_FILE" \
  --backup-dir "$BACKUP_DIR")"
remove_marker

if compose --profile maintenance run --rm --no-deps -T attachments-maintenance \
  sh -eu -c 'test -e "/srv/attachments/$1"' sh "$marker_name"; then
  die "attachment marker still exists before restore"
fi

CONFIRM_ATTACHMENTS_RESTORE=YES \
  "${SCRIPT_DIR}/restore-attachments.sh" \
    --compose-file "$COMPOSE_FILE" \
    --env-file "$ENV_FILE" \
    "$backup_file" \
    >/dev/null

restored_value="$(
  compose --profile maintenance run --rm --no-deps -T attachments-maintenance \
    sh -eu -c 'cat -- "/srv/attachments/$1"' sh "$marker_name"
)"
[[ "$restored_value" == "$marker_value" ]] || \
  die "restored attachment marker content did not match"

finish_verification_cleanup
printf 'attachment_backup_restore_verification=PASS\n'
