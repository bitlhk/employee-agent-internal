#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="${RELEASE_DEPLOY_ROOT:-/opt/employee-agent}"
SHARED_APP_ROOT="${RELEASE_SHARED_APP_ROOT:-}"
BUNDLE=""
KEEP_RELEASES="${RELEASE_KEEP_PREVIOUS:-3}"
PREPARE_ONLY=false
SKIP_BACKUP=false

usage() {
  cat <<'EOF'
Usage: scripts/deploy-release.sh --bundle FILE [options]

Options:
  --deploy-root DIR   Versioned release root (default: /opt/employee-agent)
  --shared-root DIR   Existing durable app root containing .env, data, and logs
  --keep NUMBER       Number of inactive releases to retain (default: 3)
  --prepare-only      Install, build, and migrate without switching PM2
  --skip-backup       Skip the pre-migration core backup
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --bundle) BUNDLE="${2:-}"; shift 2 ;;
    --deploy-root) DEPLOY_ROOT="${2:-}"; shift 2 ;;
    --shared-root) SHARED_APP_ROOT="${2:-}"; shift 2 ;;
    --keep) KEEP_RELEASES="${2:-}"; shift 2 ;;
    --prepare-only) PREPARE_ONLY=true; shift ;;
    --skip-backup) SKIP_BACKUP=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

source "$SCRIPT_DIR/lib/release-common.sh"
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || release_die "--bundle must reference a release archive"
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] || release_die "--keep must be a non-negative integer"
release_require_command flock
release_require_command node
release_require_command pnpm
release_require_command pm2
release_require_command sha256sum
release_require_command tar

BUNDLE="$(readlink -f "$BUNDLE")"
checksum_file="$BUNDLE.sha256"
[[ -f "$checksum_file" ]] || release_die "missing checksum file: $checksum_file"
(cd "$(dirname "$BUNDLE")" && sha256sum -c "$(basename "$checksum_file")")

mkdir -p "$DEPLOY_ROOT/releases"
exec 9>"$DEPLOY_ROOT/deploy.lock"
flock -w 120 9 || release_die "another release operation is active"

if [[ -z "$SHARED_APP_ROOT" ]]; then
  if [[ -L "$DEPLOY_ROOT/current" ]]; then
    SHARED_APP_ROOT="$(release_realpath "$DEPLOY_ROOT/current")"
  else
    release_die "--shared-root is required for the first versioned deployment"
  fi
fi
SHARED_APP_ROOT="$(readlink -f "$SHARED_APP_ROOT")"
[[ -f "$SHARED_APP_ROOT/.env" ]] || release_die "shared root does not contain .env: $SHARED_APP_ROOT"
mkdir -p "$SHARED_APP_ROOT/data" "$SHARED_APP_ROOT/logs"

while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*/..) release_die "unsafe archive path: $entry" ;;
  esac
done < <(tar -tzf "$BUNDLE")

staging="$(mktemp -d "$DEPLOY_ROOT/releases/.staging.XXXXXX")"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT
tar -xzf "$BUNDLE" -C "$staging"

manifest="$staging/release-manifest.json"
[[ -f "$manifest" ]] || release_die "release manifest is missing"
release_id="$(node -e 'const m=require(process.argv[1]); process.stdout.write(String(m.releaseId || ""))' "$manifest")"
release_validate_id "$release_id"
release_dir="$DEPLOY_ROOT/releases/$release_id"
[[ ! -e "$release_dir" ]] || release_die "release already exists: $release_id"

if [[ -d "$staging/data" ]]; then
  cp -a "$staging/data/." "$SHARED_APP_ROOT/data/"
  rm -rf "$staging/data"
fi
ln -s "$SHARED_APP_ROOT/data" "$staging/data"
ln -s "$SHARED_APP_ROOT/logs" "$staging/logs"
ln -s "$SHARED_APP_ROOT/.env" "$staging/.env"
for optional in .bootstrap-admin-password .monitor.env monitor.env; do
  if [[ -e "$SHARED_APP_ROOT/$optional" ]]; then
    ln -s "$SHARED_APP_ROOT/$optional" "$staging/$optional"
  fi
done
for config in ecosystem.config.cjs ecosystem.knowledge.config.cjs; do
  if [[ -f "$staging/$config.example" ]]; then
    cp "$staging/$config.example" "$staging/$config"
  elif [[ -f "$SHARED_APP_ROOT/$config" ]]; then
    cp "$SHARED_APP_ROOT/$config" "$staging/$config"
  fi
done
for config in ecosystem.jiuwenswarm.config.cjs; do
  if [[ -f "$SHARED_APP_ROOT/$config" ]]; then
    cp "$SHARED_APP_ROOT/$config" "$staging/$config"
  elif [[ -f "$staging/$config.example" ]]; then
    cp "$staging/$config.example" "$staging/$config"
  fi
done

mv "$staging" "$release_dir"
trap - EXIT
release_log "Installing dependencies for $release_id"
(cd "$release_dir" && pnpm install --frozen-lockfile)
(cd "$release_dir" && pnpm build)

if [[ "$SKIP_BACKUP" != true && -x "$release_dir/scripts/backup-production.sh" ]]; then
  backup_config_dir="${EMPLOYEE_AGENT_BACKUP_CONFIG_DIR:-/root/.config/employee-agent}"
  if [[ -r "$backup_config_dir/backup.env" && -r "$backup_config_dir/backup.cnf" && -r "$backup_config_dir/backup-encryption.key" ]]; then
    release_log "Creating pre-migration backup"
    backup_source_commit="$(
      if [[ -r "$DEPLOY_ROOT/current/release-manifest.json" ]]; then
        node -e 'const m=require(process.argv[1]); process.stdout.write(String(m.sourceCommit || "unknown"))' \
          "$DEPLOY_ROOT/current/release-manifest.json"
      else
        printf 'unknown'
      fi
    )"
    APP_DIR="$SHARED_APP_ROOT" BACKUP_SOURCE_ROOT="$release_dir" BACKUP_SOURCE_COMMIT="$backup_source_commit" \
      "$release_dir/scripts/backup-production.sh" --core
    "$release_dir/scripts/validate-production-backup.sh" latest
  elif [[ "${RELEASE_REQUIRE_BACKUP:-false}" == true ]]; then
    release_die "production backup is required but not configured"
  else
    release_log "Backup is not configured; continuing without a pre-migration snapshot"
  fi
fi

release_log "Applying managed database migrations"
if [[ -n "${RELEASE_MIGRATION_ENV_FILE:-}" ]]; then
  [[ -r "$RELEASE_MIGRATION_ENV_FILE" ]] || release_die "migration environment file is not readable"
  set -a
  # shellcheck disable=SC1090
  source "$RELEASE_MIGRATION_ENV_FILE"
  set +a
fi
if [[ "${RELEASE_REQUIRE_MIGRATION_URL:-false}" == true ]]; then
  if [[ -z "${DATABASE_MIGRATION_URL:-}" ]]; then
    node -e '
      const fs = require("node:fs");
      const line = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/)
        .find((item) => /^\s*DATABASE_MIGRATION_URL\s*=/.test(item));
      const value = String(line || "").replace(/^\s*DATABASE_MIGRATION_URL\s*=\s*/, "").trim().replace(/^(["'\''])(.*)\1$/, "$2");
      if (!value) process.exit(1);
    ' "$release_dir/.env" || release_die "DATABASE_MIGRATION_URL is required for production releases"
  fi
fi
(cd "$release_dir" && pnpm db:deploy)

if [[ "$PREPARE_ONLY" == true ]]; then
  release_record "$DEPLOY_ROOT" prepare "$release_id" success
  release_log "Release prepared without activation: $release_dir"
  exit 0
fi

current_target="$(release_realpath "$DEPLOY_ROOT/current")"
previous_before="$(release_realpath "$DEPLOY_ROOT/previous")"
if [[ -z "$current_target" && -f "$SHARED_APP_ROOT/ecosystem.config.cjs" ]]; then
  current_target="$SHARED_APP_ROOT"
fi
current_id="${current_target##*/}"
if [[ -n "$current_target" && -d "$current_target" ]]; then
  release_atomic_link "$current_target" "$DEPLOY_ROOT/previous"
fi
release_atomic_link "$release_dir" "$DEPLOY_ROOT/current"

rollback_on_error() {
  local failed_code=$?
  trap - ERR
  release_record "$DEPLOY_ROOT" deploy "$release_id" failed "$current_id"
  if [[ -n "$current_target" && -d "$current_target" ]]; then
    release_log "Health gate failed; rolling back to $current_id"
    release_atomic_link "$release_dir" "$DEPLOY_ROOT/failed"
    release_atomic_link "$current_target" "$DEPLOY_ROOT/current"
    if [[ -n "$previous_before" && -d "$previous_before" ]]; then
      release_atomic_link "$previous_before" "$DEPLOY_ROOT/previous"
    else
      rm -f "$DEPLOY_ROOT/previous"
    fi
    release_pm2_reload "$DEPLOY_ROOT/current"
    release_verify "$DEPLOY_ROOT/current" || release_die "rollback verification failed"
    release_record "$DEPLOY_ROOT" rollback "$current_id" success "$release_id"
  else
    pm2 delete "${PM2_APP_NAME:-employee-agent}" >/dev/null 2>&1 || true
  fi
  exit "$failed_code"
}
trap rollback_on_error ERR

release_log "Activating $release_id"
release_pm2_reload "$DEPLOY_ROOT/current"
release_verify "$DEPLOY_ROOT/current"
trap - ERR

release_record "$DEPLOY_ROOT" deploy "$release_id" success "$current_id"
release_prune "$DEPLOY_ROOT" "$KEEP_RELEASES"
pm2 save --force >/dev/null
release_log "Release active: $release_id"
