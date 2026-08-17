#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage: restore.sh [options] BACKUP_FILE TARGET_DATABASE

Restore a custom-format backup into a separate PostgreSQL database.
The target must not already exist; this script never replaces a database.
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

(( ${#positional[@]} == 2 )) || die "BACKUP_FILE and TARGET_DATABASE are required"
backup_file="${positional[0]}"
target_database="${positional[1]}"
validate_identifier "$target_database"
trap close_backup_snapshot EXIT
open_verified_backup_snapshot "$backup_file"

load_compose_context
postgres_container_id >/dev/null
wait_for_postgres

primary_database="$(postgres_env POSTGRES_DB)"
database_user="$(postgres_env POSTGRES_USER)"
validate_identifier "$primary_database"
validate_identifier "$database_user"

target_exists="$(
  compose exec --no-TTY postgres psql \
    --username "$database_user" \
    --dbname "$primary_database" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --set="target_database=$target_database" <<'SQL'
SELECT count(*)
FROM pg_database
WHERE datname = :'target_database';
SQL
)"
target_exists="${target_exists//$'\r'/}"
[[ "$target_exists" == "0" || "$target_exists" == "1" ]] || \
  die "could not determine whether target database exists: $target_database"
[[ "$target_exists" == "0" ]] || \
  die "refusing to replace existing target database: $target_database"

compose exec --no-TTY postgres pg_restore --list <&"$BACKUP_VALIDATION_FD" >/dev/null || \
  die "backup is not a readable PostgreSQL custom-format dump"
exec {BACKUP_VALIDATION_FD}<&-
BACKUP_VALIDATION_FD=""

log "creating new restore target database: $target_database"
compose exec --no-TTY postgres createdb --username "$database_user" "$target_database"

if ! compose exec --no-TTY postgres pg_restore \
  --username "$database_user" \
  --dbname "$target_database" \
  --exit-on-error \
  --no-owner \
  --no-acl \
  <&"$BACKUP_SNAPSHOT_FD"; then
  if compose exec --no-TTY postgres dropdb \
    --force \
    --username "$database_user" \
    "$target_database"; then
    die "restore failed; newly created target database was removed"
  fi
  die "restore failed and cleanup also failed; partially restored database may remain: $target_database"
fi

close_backup_snapshot
trap - EXIT
printf '%s\n' "$target_database"
