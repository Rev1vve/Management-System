#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage: verify-persistence.sh [options]

Verify that PostgreSQL data survives container recreation while the named volume
is preserved. Temporary validation data is removed afterward.
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

database_name="$(postgres_env POSTGRES_DB)"
database_user="$(postgres_env POSTGRES_USER)"
validate_identifier "$database_name"
validate_identifier "$database_user"
marker="persistence-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
before_container="$(postgres_container_id)"

cleanup() {
  local cleanup_failed=0
  if ! compose up --detach postgres; then
    log "ERROR: could not start PostgreSQL for persistence cleanup"
    cleanup_failed=1
  elif ! (wait_for_postgres 120); then
    log "ERROR: PostgreSQL did not become ready for persistence cleanup"
    cleanup_failed=1
  elif ! compose exec --no-TTY postgres psql \
    --username "$database_user" \
    --dbname "$database_name" \
    --command 'DROP SCHEMA IF EXISTS infra_verify CASCADE'; then
    log "ERROR: could not remove persistence verification schema"
    cleanup_failed=1
  fi
  (( cleanup_failed == 0 ))
}
register_verification_cleanup cleanup

compose exec --no-TTY postgres psql \
  --username "$database_user" \
  --dbname "$database_name" \
  --set=ON_ERROR_STOP=1 \
  --set="marker=$marker" <<'SQL'
CREATE SCHEMA IF NOT EXISTS infra_verify;
CREATE TABLE IF NOT EXISTS infra_verify.persistence_probe (
  value text PRIMARY KEY
);
TRUNCATE infra_verify.persistence_probe;
INSERT INTO infra_verify.persistence_probe(value) VALUES (:'marker');
SQL

compose stop --timeout 60 postgres
compose rm --force postgres
compose up --detach postgres
wait_for_postgres

after_container="$(postgres_container_id)"
[[ "$after_container" != "$before_container" ]] || die "PostgreSQL container was not recreated"

persisted_count="$(
  compose exec --no-TTY postgres psql \
    --username "$database_user" \
    --dbname "$database_name" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --set="marker=$marker" <<'SQL'
SELECT count(*)
FROM infra_verify.persistence_probe
WHERE value = :'marker';
SQL
)"
persisted_count="${persisted_count//$'\r'/}"
[[ "$persisted_count" == "1" ]] || die "validation marker did not survive container recreation"

finish_verification_cleanup
printf 'persistence_verification=PASS\n'
