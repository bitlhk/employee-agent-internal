#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="${RELEASE_DEPLOY_ROOT:-/opt/employee-agent}"
TARGET_ID=""

source "$SCRIPT_DIR/lib/release-common.sh"

usage() {
  echo "Usage: scripts/rollback-release.sh [--deploy-root DIR] [RELEASE_ID]"
}

while (( $# > 0 )); do
  case "$1" in
    --deploy-root) DEPLOY_ROOT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    *) [[ -z "$TARGET_ID" ]] || release_die "only one release id may be provided"; TARGET_ID="$1"; shift ;;
  esac
done

release_require_command flock
release_require_command pm2
[[ -d "$DEPLOY_ROOT/releases" ]] || release_die "release root does not exist: $DEPLOY_ROOT"
exec 9>"$DEPLOY_ROOT/deploy.lock"
flock -w 120 9 || release_die "another release operation is active"

current_target="$(release_realpath "$DEPLOY_ROOT/current")"
[[ -d "$current_target" ]] || release_die "there is no active release"
current_id="${current_target##*/}"

if [[ -n "$TARGET_ID" ]]; then
  release_validate_id "$TARGET_ID"
  target="$DEPLOY_ROOT/releases/$TARGET_ID"
else
  target="$(release_previous_target "$DEPLOY_ROOT" "$current_target")"
fi
[[ -n "$target" && -d "$target" ]] || release_die "no rollback target is available"
target="$(readlink -f "$target")"
target_id="${target##*/}"
[[ "$target" != "$current_target" ]] || release_die "$target_id is already active"

release_atomic_link "$current_target" "$DEPLOY_ROOT/previous"
release_atomic_link "$target" "$DEPLOY_ROOT/current"

rollback_failed() {
  local failed_code=$?
  trap - ERR
  release_atomic_link "$current_target" "$DEPLOY_ROOT/current"
  release_pm2_reload "$DEPLOY_ROOT/current"
  release_verify "$DEPLOY_ROOT/current" || true
  release_record "$DEPLOY_ROOT" rollback "$target_id" failed "$current_id"
  exit "$failed_code"
}
trap rollback_failed ERR

release_pm2_reload "$DEPLOY_ROOT/current"
release_verify "$DEPLOY_ROOT/current"
trap - ERR

release_record "$DEPLOY_ROOT" rollback "$target_id" success "$current_id"
pm2 save --force >/dev/null
release_log "Rollback complete: $current_id -> $target_id"
