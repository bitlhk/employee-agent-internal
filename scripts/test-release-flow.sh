#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

fake_bin="$ROOT/bin"
shared_root="$ROOT/shared"
deploy_root="$ROOT/deploy"
bundle_root="$ROOT/bundles"
mkdir -p "$fake_bin" "$shared_root/data" "$shared_root/logs" "$shared_root/scripts" "$bundle_root"

printf '#!/usr/bin/env bash\nexit 0\n' > "$fake_bin/pnpm"
printf '#!/usr/bin/env bash\nexit 0\n' > "$fake_bin/pm2"
chmod +x "$fake_bin/pnpm" "$fake_bin/pm2"

printf 'DATABASE_URL=mysql://unused\n' > "$shared_root/.env"
printf 'module.exports={apps:[]};\n' > "$shared_root/ecosystem.config.cjs"
printf '#!/usr/bin/env bash\nexit 0\n' > "$shared_root/scripts/verify-production-release.sh"
chmod +x "$shared_root/scripts/verify-production-release.sh"

make_bundle() {
  local release_id="$1"
  local verify_exit="$2"
  local source="$ROOT/source-$release_id"
  local bundle="$bundle_root/employee-agent-$release_id.tar.gz"
  mkdir -p "$source/scripts"
  printf '{"schema":1,"releaseId":"%s","sourceCommit":"test","createdAt":"2026-01-01T00:00:00Z"}\n' "$release_id" > "$source/release-manifest.json"
  printf '#!/usr/bin/env bash\nexit %s\n' "$verify_exit" > "$source/scripts/verify-production-release.sh"
  chmod +x "$source/scripts/verify-production-release.sh"
  tar -C "$source" -czf "$bundle" .
  (cd "$bundle_root" && sha256sum "$(basename "$bundle")" > "$(basename "$bundle").sha256")
  printf '%s' "$bundle"
}

bundle_missing_migration="$(make_bundle release-missing-migration 0)"
if PATH="$fake_bin:$PATH" RELEASE_REQUIRE_MIGRATION_URL=true "$SCRIPT_DIR/deploy-release.sh" \
  --bundle "$bundle_missing_migration" \
  --deploy-root "$deploy_root" \
  --shared-root "$shared_root" \
  --prepare-only \
  --skip-backup; then
  echo "production release accepted a missing migration URL" >&2
  exit 1
fi

bundle_v1="$(make_bundle release-v1 0)"
PATH="$fake_bin:$PATH" DATABASE_MIGRATION_URL=mysql://unused "$SCRIPT_DIR/deploy-release.sh" \
  --bundle "$bundle_v1" \
  --deploy-root "$deploy_root" \
  --shared-root "$shared_root" \
  --skip-backup

[[ "$(readlink -f "$deploy_root/current")" == "$deploy_root/releases/release-v1" ]]
[[ "$(readlink -f "$deploy_root/previous")" == "$shared_root" ]]
[[ "$(readlink -f "$deploy_root/current/data")" == "$shared_root/data" ]]

bundle_v2="$(make_bundle release-v2 1)"
if PATH="$fake_bin:$PATH" DATABASE_MIGRATION_URL=mysql://unused "$SCRIPT_DIR/deploy-release.sh" \
  --bundle "$bundle_v2" \
  --deploy-root "$deploy_root" \
  --shared-root "$shared_root" \
  --skip-backup; then
  echo "failed release unexpectedly passed its health gate" >&2
  exit 1
fi

[[ "$(readlink -f "$deploy_root/current")" == "$deploy_root/releases/release-v1" ]]
[[ "$(readlink -f "$deploy_root/previous")" == "$shared_root" ]]
[[ "$(readlink -f "$deploy_root/failed")" == "$deploy_root/releases/release-v2" ]]

PATH="$fake_bin:$PATH" "$SCRIPT_DIR/rollback-release.sh" --deploy-root "$deploy_root"
[[ "$(readlink -f "$deploy_root/current")" == "$shared_root" ]]
[[ "$(readlink -f "$deploy_root/previous")" == "$deploy_root/releases/release-v1" ]]

grep -F '"action":"deploy","release":"release-v1"' "$deploy_root/deployments.log" >/dev/null
grep -F '"action":"deploy","release":"release-v2"' "$deploy_root/deployments.log" >/dev/null
grep -F '"action":"rollback","release":"shared"' "$deploy_root/deployments.log" >/dev/null

echo "release deployment and rollback test passed"
