#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage: backup.sh [options]

Create a PostgreSQL custom-format backup and SHA-256 sidecar.
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
postgres_container_id >/dev/null
wait_for_postgres

umask 077
install -d -m 700 "$BACKUP_DIR"
backup_id="$(new_backup_id)"
backup_name="project-operations-${backup_id}.dump"
backup_path="${BACKUP_DIR}/${backup_name}"
temporary_path="${backup_path}.partial.$$"
checksum_path="${backup_path}.sha256"
temporary_checksum_path="${checksum_path}.partial.$$"
trap 'rm -f "$temporary_path" "$temporary_checksum_path"' EXIT

log "creating PostgreSQL backup"
compose exec --no-TTY postgres sh -eu -c \
  'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
  > "$temporary_path"
[[ -s "$temporary_path" ]] || die "pg_dump produced an empty backup"
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
