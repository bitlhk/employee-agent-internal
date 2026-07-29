#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

fake_bin="$ROOT/bin"
app_root="$ROOT/app"
mkdir -p "$fake_bin" "$app_root"
touch "$app_root/ecosystem.jiuwenswarm.config.cjs"

cat > "$fake_bin/pm2" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_PM2_LOG"
if [[ "${1:-}" == "pid" ]]; then
  printf '123\n'
fi
EOF

cat > "$fake_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_SYSTEMD_LOG"
case "${1:-}" in
  show)
    if [[ "$FAKE_SYSTEMD_MODE" == "absent" ]]; then
      printf 'not-found\n'
    else
      printf 'loaded\n'
    fi
    ;;
  is-active)
    [[ "$FAKE_SYSTEMD_MODE" == "loaded" ]]
    ;;
  *)
    exit 1
    ;;
esac
EOF

cat > "$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
url="${*: -1}"
if [[ "$url" == */internal/metrics ]]; then
  printf 'ea_http_requests_total 1\n'
  printf 'ea_backup_last_validation_timestamp_seconds 1\n'
fi
EOF
chmod +x "$fake_bin/pm2" "$fake_bin/systemctl" "$fake_bin/curl"

export FAKE_PM2_LOG="$ROOT/pm2.log"
export FAKE_SYSTEMD_LOG="$ROOT/systemd.log"

run_verifier() {
  PATH="$fake_bin:$PATH" \
    APP_ROOT="$app_root" \
    APP_URL="http://127.0.0.1:5180" \
    VERIFY_ATTEMPTS=1 \
    "$SCRIPT_DIR/verify-production-release.sh"
}

export FAKE_SYSTEMD_MODE=loaded
: > "$FAKE_PM2_LOG"
: > "$FAKE_SYSTEMD_LOG"
run_verifier
! grep -q 'jiuwenswarm-agentserver' "$FAKE_PM2_LOG"
grep -q 'is-active --quiet jiuwenswarm.service' "$FAKE_SYSTEMD_LOG"
grep -q 'is-active --quiet jiuwenbox.service' "$FAKE_SYSTEMD_LOG"

export FAKE_SYSTEMD_MODE=absent
: > "$FAKE_PM2_LOG"
: > "$FAKE_SYSTEMD_LOG"
run_verifier
grep -q 'pid jiuwenswarm-agentserver' "$FAKE_PM2_LOG"
grep -q 'pid jiuwenswarm-gateway' "$FAKE_PM2_LOG"

export FAKE_SYSTEMD_MODE=failed
: > "$FAKE_PM2_LOG"
: > "$FAKE_SYSTEMD_LOG"
if run_verifier; then
  echo "inactive JiuwenSwarm systemd service passed verification" >&2
  exit 1
fi

echo "production verifier service-manager test passed"
