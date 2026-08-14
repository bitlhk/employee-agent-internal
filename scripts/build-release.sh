#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${RELEASE_OUTPUT_DIR:-$APP_ROOT/dist/releases}"
RELEASE_ID="${RELEASE_ID:-}"

usage() {
  cat <<'EOF'
Usage: scripts/build-release.sh [--id RELEASE_ID] [--output DIR]

Builds a source release from the current committed Git tree. The worktree must
be clean so the manifest and deployed code always refer to the same commit.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --id) RELEASE_ID="${2:-}"; shift 2 ;;
    --output) OUTPUT_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

source "$SCRIPT_DIR/lib/release-common.sh"
release_require_command git
release_require_command node
release_require_command tar
release_require_command sha256sum

source_repository="${RELEASE_SOURCE_REPOSITORY:-}"
if [[ -z "$source_repository" ]]; then
  origin_url="$(git -C "$APP_ROOT" remote get-url origin 2>/dev/null || true)"
  case "$origin_url" in
    https://github.com/*) source_repository="${origin_url#https://github.com/}" ;;
    git@github.com:*) source_repository="${origin_url#git@github.com:}" ;;
    *) source_repository="" ;;
  esac
  source_repository="${source_repository%.git}"
fi
[[ "$source_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || release_die "RELEASE_SOURCE_REPOSITORY must identify the GitHub owner/repository"

git -C "$APP_ROOT" diff --quiet --ignore-submodules -- || release_die "worktree has unstaged changes"
git -C "$APP_ROOT" diff --cached --quiet --ignore-submodules -- || release_die "worktree has staged changes"
[[ -z "$(git -C "$APP_ROOT" ls-files --others --exclude-standard)" ]] || release_die "worktree has untracked files"

commit="$(git -C "$APP_ROOT" rev-parse HEAD)"
short_commit="$(git -C "$APP_ROOT" rev-parse --short=12 HEAD)"
if [[ -z "$RELEASE_ID" ]]; then
  RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$short_commit"
fi
release_validate_id "$RELEASE_ID"

mkdir -p "$OUTPUT_DIR"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

git -C "$APP_ROOT" archive --format=tar HEAD | tar -xf - -C "$staging"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
(
  cd "$staging"
  node scripts/generate-release-manifest.mjs \
    --output release-manifest.json \
    --release-id "$RELEASE_ID" \
    --source-commit "$commit" \
    --source-repository "$source_repository" \
    --created-at "$created_at"
)

bundle="$OUTPUT_DIR/employee-agent-$RELEASE_ID.tar.gz"
tar -C "$staging" -czf "$bundle" .
(
  cd "$OUTPUT_DIR"
  sha256sum "$(basename "$bundle")" > "$(basename "$bundle").sha256"
)

release_log "Release bundle created"
echo "$bundle"
cat "$bundle.sha256"
