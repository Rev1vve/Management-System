#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'USAGE'
Usage: cleanup-verification.sh [options]

Stop the disposable verification project and delete all of its named volumes,
including volumes declared by the disabled maintenance profile. The resolved
Compose project name must explicitly contain "verify".
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
compose --profile maintenance down --volumes --remove-orphans
printf 'verification_cleanup=PASS\n'
