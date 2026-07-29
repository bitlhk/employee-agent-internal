#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="${RELEASE_DEPLOY_ROOT:-/opt/employee-agent}"
if [[ "${1:-}" == "--deploy-root" ]]; then
  DEPLOY_ROOT="${2:-}"
fi
source "$SCRIPT_DIR/lib/release-common.sh"

for name in current previous failed; do
  target="$(release_realpath "$DEPLOY_ROOT/$name")"
  if [[ -n "$target" ]]; then
    printf '%-9s %s\n' "$name" "${target##*/}"
  else
    printf '%-9s %s\n' "$name" "-"
  fi
done

echo
echo "Available releases:"
find "$DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -r
