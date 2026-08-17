#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage: verify-infrastructure.sh [options]

Start only the development PostgreSQL service and verify:
- no host port is published for PostgreSQL
- every attached PostgreSQL network is internal
- named-volume persistence across container recreation
- backup and restore into a temporary database
- attachment-volume persistence, backup, deletion, and exact-content restore
- production Caddyfile syntax using the pinned image
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

cleanup() {
  "${SCRIPT_DIR}/cleanup-verification.sh" \
    --compose-file "$COMPOSE_FILE" \
    --env-file "$ENV_FILE" \
    --backup-dir "$BACKUP_DIR"
}
register_verification_cleanup cleanup

compose --profile maintenance pull postgres attachments-maintenance
compose up --detach postgres
wait_for_postgres
container_id="$(postgres_container_id)"

port_bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$container_id")"
[[ "$port_bindings" == "{}" || "$port_bindings" == "null" ]] || die "PostgreSQL unexpectedly publishes a host port: $port_bindings"

read -r -a network_names <<< "$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container_id")"
(( ${#network_names[@]} > 0 )) || die "PostgreSQL is not attached to a Docker network"
for network_name in "${network_names[@]}"; do
  internal="$(docker network inspect --format '{{.Internal}}' "$network_name")"
  [[ "$internal" == "true" ]] || die "PostgreSQL network is not internal: $network_name"
done

"${SCRIPT_DIR}/verify-persistence.sh" --compose-file "$COMPOSE_FILE" --env-file "$ENV_FILE" --backup-dir "$BACKUP_DIR"
"${SCRIPT_DIR}/verify-backup-restore.sh" --compose-file "$COMPOSE_FILE" --env-file "$ENV_FILE" --backup-dir "$BACKUP_DIR"
"${SCRIPT_DIR}/verify-attachments.sh" --compose-file "$COMPOSE_FILE" --env-file "$ENV_FILE" --backup-dir "$BACKUP_DIR"

caddy_image="caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648"
docker run --rm \
  --volume "${INFRA_DIR}/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$caddy_image" \
  caddy fmt --diff /etc/caddy/Caddyfile >/dev/null
docker run --rm \
  --volume "${INFRA_DIR}/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$caddy_image" \
  caddy validate --config /etc/caddy/Caddyfile >/dev/null

finish_verification_cleanup
printf 'infrastructure_verification=PASS\n'
