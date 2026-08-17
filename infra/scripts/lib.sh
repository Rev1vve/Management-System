#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${INFRA_DIR}/.." && pwd)"

COMPOSE_FILE="${COMPOSE_FILE:-${INFRA_DIR}/compose.dev.yml}"
ENV_FILE="${ENV_FILE:-${INFRA_DIR}/env/dev.env}"
BACKUP_DIR="${BACKUP_DIR:-${HOME}/project-operations-center-backups}"
COMPOSE_ARGS=()
BACKUP_SNAPSHOT_DIR=""
BACKUP_SNAPSHOT_FD=""
BACKUP_VALIDATION_FD=""
VERIFICATION_CLEANUP_FUNCTION=""

log() {
  printf '[infra] %s\n' "$*" >&2
}

die() {
  printf '[infra] ERROR: %s\n' "$*" >&2
  exit 1
}

run_registered_verification_cleanup() {
  [[ -n "${VERIFICATION_CLEANUP_FUNCTION:-}" ]] || return 0
  "${VERIFICATION_CLEANUP_FUNCTION}"
}

verification_cleanup_on_exit() {
  local exit_status=$?
  trap - EXIT
  if ! run_registered_verification_cleanup; then
    log "ERROR: verification cleanup failed"
    exit 1
  fi
  VERIFICATION_CLEANUP_FUNCTION=""
  exit "$exit_status"
}

register_verification_cleanup() {
  local cleanup_function="$1"
  [[ "$cleanup_function" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || \
    die "invalid verification cleanup function: $cleanup_function"
  declare -F -- "$cleanup_function" >/dev/null || \
    die "verification cleanup function is not defined: $cleanup_function"
  VERIFICATION_CLEANUP_FUNCTION="$cleanup_function"
  trap verification_cleanup_on_exit EXIT
}

finish_verification_cleanup() {
  trap - EXIT
  if ! run_registered_verification_cleanup; then
    VERIFICATION_CLEANUP_FUNCTION=""
    die "verification cleanup failed"
  fi
  VERIFICATION_CLEANUP_FUNCTION=""
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

validate_identifier() {
  local value="$1"
  [[ "$value" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "'$value' is not a valid PostgreSQL identifier"
}

read_sha256_digest() {
  local checksum_file="$1"
  local checksum_line expected_checksum remainder
  local -a checksum_lines=()

  [[ -f "$checksum_file" ]] || die "checksum sidecar is required: $checksum_file"
  mapfile -t checksum_lines < "$checksum_file"
  (( ${#checksum_lines[@]} == 1 )) || die "malformed checksum sidecar: $checksum_file"
  checksum_line="${checksum_lines[0]}"
  if [[ "${checksum_line:0:1}" == "\\" ]]; then
    checksum_line="${checksum_line:1}"
  fi
  expected_checksum="${checksum_line:0:64}"
  remainder="${checksum_line:64}"
  [[ "$expected_checksum" =~ ^[0-9A-Fa-f]{64}$ ]] || \
    die "malformed checksum sidecar: $checksum_file"
  [[ -z "$remainder" || "$remainder" =~ ^[[:space:]]+.+$ ]] || \
    die "malformed checksum sidecar: $checksum_file"
  printf '%s\n' "${expected_checksum,,}"
}

verify_sha256_sidecar() {
  local backup_file="$1"
  local checksum_file="${backup_file}.sha256"
  local expected_checksum actual_line actual_checksum

  require_command sha256sum
  expected_checksum="$(read_sha256_digest "$checksum_file")"
  actual_line="$(sha256sum < "$backup_file")"
  actual_checksum="${actual_line%% *}"
  [[ "$actual_checksum" == "$expected_checksum" ]] || \
    die "checksum does not match selected backup file: $backup_file"
}

close_backup_snapshot() {
  if [[ -n "${BACKUP_VALIDATION_FD:-}" ]]; then
    exec {BACKUP_VALIDATION_FD}<&- || true
    BACKUP_VALIDATION_FD=""
  fi
  if [[ -n "${BACKUP_SNAPSHOT_FD:-}" ]]; then
    exec {BACKUP_SNAPSHOT_FD}<&- || true
    BACKUP_SNAPSHOT_FD=""
  fi
  if [[ -n "${BACKUP_SNAPSHOT_DIR:-}" ]]; then
    rm -f -- \
      "${BACKUP_SNAPSHOT_DIR}/backup.data" \
      "${BACKUP_SNAPSHOT_DIR}/backup.data.sha256"
    rmdir -- "$BACKUP_SNAPSHOT_DIR" 2>/dev/null || true
    BACKUP_SNAPSHOT_DIR=""
  fi
}

open_verified_backup_snapshot() {
  local backup_file="$1"
  local checksum_file="${backup_file}.sha256"
  local snapshot_file snapshot_checksum_file
  local expected_checksum actual_line actual_checksum checksum_fd

  require_command cp
  require_command mktemp
  require_command sha256sum
  [[ -f "$backup_file" ]] || die "backup file not found: $backup_file"
  [[ -f "$checksum_file" ]] || die "checksum sidecar is required: $checksum_file"

  umask 077
  BACKUP_SNAPSHOT_DIR="$(mktemp -d -- "${TMPDIR:-/tmp}/project-operations-restore.XXXXXX")"
  chmod 700 "$BACKUP_SNAPSHOT_DIR"
  snapshot_file="${BACKUP_SNAPSHOT_DIR}/backup.data"
  snapshot_checksum_file="${snapshot_file}.sha256"
  cp --reflink=never -- "$backup_file" "$snapshot_file"
  cp --reflink=never -- "$checksum_file" "$snapshot_checksum_file"
  chmod 400 "$snapshot_file" "$snapshot_checksum_file"

  expected_checksum="$(read_sha256_digest "$snapshot_checksum_file")"
  exec {BACKUP_SNAPSHOT_FD}<"$snapshot_file"
  exec {BACKUP_VALIDATION_FD}<"$snapshot_file"
  exec {checksum_fd}<"$snapshot_file"
  rm -f -- "$snapshot_file" "$snapshot_checksum_file"
  rmdir -- "$BACKUP_SNAPSHOT_DIR"
  BACKUP_SNAPSHOT_DIR=""

  actual_line="$(sha256sum <&"$checksum_fd")"
  exec {checksum_fd}<&-
  actual_checksum="${actual_line%% *}"
  [[ "$actual_checksum" == "$expected_checksum" ]] || \
    die "checksum does not match selected backup file: $backup_file"
}

require_backup_dir_outside_repo() {
  require_command realpath
  local resolved_repo resolved_backup
  resolved_repo="$(realpath -m -- "$REPO_ROOT")"
  resolved_backup="$(realpath -m -- "$BACKUP_DIR")"
  case "$resolved_backup" in
    "$resolved_repo" | "$resolved_repo"/*)
      die "backup directory must be outside repository: $resolved_backup"
      ;;
  esac
}

new_backup_id() {
  printf '%s-%s-%s\n' "$(date -u +%Y%m%dT%H%M%S.%NZ)" "$$" "$RANDOM"
}

publish_backup_pair() {
  local temporary_backup="$1"
  local final_backup="$2"
  local temporary_checksum="$3"
  local final_checksum="$4"
  local final_path

  for final_path in "$final_backup" "$final_checksum"; do
    [[ ! -e "$final_path" && ! -L "$final_path" ]] || \
      die "refusing to overwrite existing backup artifact: $final_path"
  done

  ln -- "$temporary_backup" "$final_backup" || \
    die "could not publish backup without clobbering: $final_backup"
  if ! ln -- "$temporary_checksum" "$final_checksum"; then
    rm -f -- "$final_backup"
    die "could not publish checksum without clobbering: $final_checksum"
  fi
  rm -f -- "$temporary_backup" "$temporary_checksum"
}

validate_attachment_archive() {
  local archive_path="$1"
  require_command python3
  python3 - "$archive_path" <<'PY'
from pathlib import PurePosixPath
import sys
import tarfile

archive_path = sys.argv[1]
try:
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            unsafe_path = path.is_absolute() or ".." in path.parts
            unsafe_type = not (member.isfile() or member.isdir())
            if unsafe_path or unsafe_type:
                print(
                    f"[infra] ERROR: unsafe attachment archive member: {member.name}",
                    file=sys.stderr,
                )
                raise SystemExit(1)
except (tarfile.TarError, OSError) as error:
    print(f"[infra] ERROR: unsafe attachment archive member: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
}

load_compose_context() {
  require_command docker
  require_command sha256sum
  [[ -f "$COMPOSE_FILE" ]] || die "Compose file not found: $COMPOSE_FILE"
  [[ -f "$ENV_FILE" ]] || die "environment file not found: $ENV_FILE"

  COMPOSE_ARGS=(--file "$COMPOSE_FILE" --env-file "$ENV_FILE")
  docker compose "${COMPOSE_ARGS[@]}" config --quiet >/dev/null
}

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

require_disposable_project() {
  require_command python3
  local project_name
  project_name="$(
    compose config --format json | \
      python3 -c 'import json, sys; print(json.load(sys.stdin)["name"])'
  )"
  [[ "$project_name" =~ (^|[-_])verify($|[-_]) ]] || \
    die "refusing destructive verification for non-disposable Compose project: $project_name"
  log "using disposable Compose project: $project_name"
}

postgres_container_id() {
  local container_id
  container_id="$(compose ps --quiet postgres)"
  [[ -n "$container_id" ]] || die "PostgreSQL service is not running"
  printf '%s\n' "$container_id"
}

wait_for_postgres() {
  local timeout_seconds="${1:-120}"
  local deadline=$((SECONDS + timeout_seconds))
  local container_id status

  while (( SECONDS < deadline )); do
    container_id="$(compose ps --quiet postgres 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$status" == "healthy" ]]; then
        return 0
      fi
      if [[ "$status" == "exited" || "$status" == "dead" ]]; then
        compose logs postgres >&2 || true
        die "PostgreSQL exited before becoming healthy"
      fi
    fi
    sleep 2
  done

  compose logs postgres >&2 || true
  die "PostgreSQL did not become healthy within ${timeout_seconds}s"
}

postgres_env() {
  local variable="$1"
  local value
  value="$(compose exec --no-TTY postgres printenv "$variable")"
  value="${value//$'\x0d'/}"
  [[ -n "$value" ]] || die "PostgreSQL environment variable is empty: $variable"
  printf '%s\n' "$value"
}

common_usage() {
  cat <<'USAGE'
Common options:
  --compose-file FILE  Compose file to use (default: infra/compose.dev.yml)
  --env-file FILE      Compose environment file (default: infra/env/dev.env)
  --backup-dir DIR     Backup directory outside the repository
  --help               Show help
USAGE
}

parse_common_option() {
  case "$1" in
    --compose-file)
      [[ $# -ge 2 ]] || die "--compose-file requires a value"
      COMPOSE_FILE="$2"
      PARSED_OPTION_COUNT=2
      ;;
    --env-file)
      [[ $# -ge 2 ]] || die "--env-file requires a value"
      ENV_FILE="$2"
      PARSED_OPTION_COUNT=2
      ;;
    --backup-dir)
      [[ $# -ge 2 ]] || die "--backup-dir requires a value"
      BACKUP_DIR="$2"
      PARSED_OPTION_COUNT=2
      ;;
    *)
      PARSED_OPTION_COUNT=0
      ;;
  esac
}
