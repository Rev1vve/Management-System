#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage: verify-backup-restore.sh [options]

Create temporary validation data, back it up, restore it to a temporary database,
and verify the restored value. All validation data is removed afterward.
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
postgres_container_id >/dev/null
wait_for_postgres

source_database="$(postgres_env POSTGRES_DB)"
database_user="$(postgres_env POSTGRES_USER)"
validate_identifier "$source_database"
validate_identifier "$database_user"
target_database="infra_restore_verify_$$_${RANDOM}"
validate_identifier "$target_database"
marker="backup-restore-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
backup_file=""
target_created="NO"

cleanup() {
  local cleanup_failed=0
  if ! compose exec --no-TTY postgres psql \
    --username "$database_user" \
    --dbname "$source_database" \
    --command 'DROP SCHEMA IF EXISTS infra_verify CASCADE'; then
    log "ERROR: could not remove backup verification schema"
    cleanup_failed=1
  fi
  if [[ "$target_created" == "YES" ]]; then
    if ! compose exec --no-TTY postgres dropdb \
      --if-exists \
      --force \
      --username "$database_user" \
      "$target_database"; then
      log "ERROR: could not remove owned restore target: $target_database"
      cleanup_failed=1
    fi
  fi
  if [[ -n "$backup_file" && "${KEEP_VERIFY_BACKUP:-NO}" != "YES" ]]; then
    if ! rm -f -- "$backup_file" "${backup_file}.sha256"; then
      log "ERROR: could not remove backup verification artifacts"
      cleanup_failed=1
    fi
  fi
  (( cleanup_failed == 0 ))
}
register_verification_cleanup cleanup

compose exec --no-TTY postgres psql \
  --username "$database_user" \
  --dbname "$source_database" \
  --set=ON_ERROR_STOP=1 \
  --set="marker=$marker" <<'SQL'
CREATE SCHEMA IF NOT EXISTS infra_verify;
CREATE TABLE IF NOT EXISTS infra_verify.backup_probe (
  value text PRIMARY KEY
);
TRUNCATE infra_verify.backup_probe;
INSERT INTO infra_verify.backup_probe(value) VALUES (:'marker');
SQL

backup_file="$("${SCRIPT_DIR}/backup.sh" \
  --compose-file "$COMPOSE_FILE" \
  --env-file "$ENV_FILE" \
  --backup-dir "$BACKUP_DIR")"
"${SCRIPT_DIR}/restore.sh" \
  --compose-file "$COMPOSE_FILE" \
  --env-file "$ENV_FILE" \
  "$backup_file" \
  "$target_database" \
  >/dev/null
target_created="YES"

restored_count="$(
  compose exec --no-TTY postgres psql \
    --username "$database_user" \
    --dbname "$target_database" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --set="marker=$marker" <<'SQL'
SELECT count(*)
FROM infra_verify.backup_probe
WHERE value = :'marker';
SQL
)"
restored_count="${restored_count//$'\r'/}"
[[ "$restored_count" == "1" ]] || die "restored validation marker was not found"

refusal_output=""
if refusal_output="$(
  "${SCRIPT_DIR}/restore.sh" \
    --compose-file "$COMPOSE_FILE" \
    --env-file "$ENV_FILE" \
    "$backup_file" \
    "$target_database" \
    2>&1
)"; then
  die "restore unexpectedly replaced existing target"
fi
[[ "$refusal_output" == *"refusing to replace existing target database: $target_database"* ]] || \
  die "restore failed for an unexpected reason"

preserved_count="$(
  compose exec --no-TTY postgres psql \
    --username "$database_user" \
    --dbname "$target_database" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --set="marker=$marker" <<'SQL'
SELECT count(*)
FROM infra_verify.backup_probe
WHERE value = :'marker';
SQL
)"
preserved_count="${preserved_count//$'\r'/}"
[[ "$preserved_count" == "1" ]] || \
  die "existing restore target changed after refused replacement"

finish_verification_cleanup
printf 'existing_target_refusal=PASS\n'
printf 'backup_restore_verification=PASS\n'
