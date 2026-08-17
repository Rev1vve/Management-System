#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage: backup-attachments.sh [options]

Create a gzip-compressed attachment-volume backup and SHA-256 sidecar.
The database backup is separate; this command does not create a consistent
cross-resource production recovery point.
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

require_backup_dir_outside_repo
load_compose_context

umask 077
install -d -m 700 "$BACKUP_DIR"
backup_id="$(new_backup_id)"
backup_name="project-operations-attachments-${backup_id}.tar.gz"
backup_path="${BACKUP_DIR}/${backup_name}"
temporary_path="${backup_path}.partial.$$"
checksum_path="${backup_path}.sha256"
temporary_checksum_path="${checksum_path}.partial.$$"
trap 'rm -f "$temporary_path" "$temporary_checksum_path"' EXIT

log "creating attachment-volume backup"
compose --profile maintenance run --rm --no-deps -T attachments-maintenance \
  sh -eu -c 'exec tar -czf - -C /srv/attachments .' \
  > "$temporary_path"
[[ -s "$temporary_path" ]] || die "attachment backup produced an empty archive"
validate_attachment_archive "$temporary_path"
chmod 600 "$temporary_path"
checksum_line="$(sha256sum < "$temporary_path")"
checksum_value="${checksum_line%% *}"
printf '%s  %s\n' "$checksum_value" "$backup_name" > "$temporary_checksum_path"
chmod 600 "$temporary_checksum_path"
publish_backup_pair \
  "$temporary_path" \
  "$backup_path" \
  "$temporary_checksum_path" \
  "$checksum_path"
trap - EXIT
printf '%s\n' "$backup_path"
