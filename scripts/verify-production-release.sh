#!/usr/bin/env bash
set -Eeuo pipefail

: "${APP_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
: "${APP_URL:=http://127.0.0.1:5180}"
: "${VERIFY_ATTEMPTS:=30}"
: "${VERIFY_INTERVAL_SECONDS:=2}"
: "${REQUIRE_PROMETHEUS:=false}"
: "${PROMETHEUS_URL:=http://127.0.0.1:9090}"

required_processes=(
  "${PM2_APP_NAME:-employee-agent}"
  "${PM2_KNOWLEDGE_APP_NAME:-employee-agent-knowledge}"
)
if [[ -f "$APP_ROOT/ecosystem.jiuwenswarm.config.cjs" ]]; then
  required_processes+=(jiuwenswarm-agentserver jiuwenswarm-gateway)
fi
if [[ -n "${REQUIRED_PM2_PROCESSES:-}" ]]; then
  read -r -a required_processes <<< "$REQUIRED_PM2_PROCESSES"
fi

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v pm2 >/dev/null || { echo "pm2 is required" >&2; exit 1; }

for process_name in "${required_processes[@]}"; do
  pid="$(pm2 pid "$process_name" 2>/dev/null | tail -n 1)"
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "required PM2 process is not online: $process_name" >&2
    exit 1
  fi
done

wait_for_endpoint() {
  local endpoint="$1"
  local attempt
  for ((attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1)); do
    if curl -fsS --max-time 5 "$endpoint" >/dev/null; then
      return 0
    fi
    sleep "$VERIFY_INTERVAL_SECONDS"
  done
  echo "release verification failed: $endpoint" >&2
  return 1
}

wait_for_endpoint "$APP_URL/health/live"
wait_for_endpoint "$APP_URL/health/ready"

metrics_token="${METRICS_BEARER_TOKEN:-}"
if [[ -z "$metrics_token" && -r "$APP_ROOT/.env" && -f "$APP_ROOT/node_modules/dotenv/package.json" ]]; then
  metrics_token="$(
    cd "$APP_ROOT"
    APP_ENV_FILE="$APP_ROOT/.env" node -e '
      require("dotenv").config({ path: process.env.APP_ENV_FILE, quiet: true });
      process.stdout.write(String(process.env.METRICS_BEARER_TOKEN || ""));
    '
  )"
fi

metrics_headers=()
if [[ -n "$metrics_token" ]]; then
  metrics_headers=(-H "Authorization: Bearer $metrics_token")
fi
metrics="$(curl -fsS --max-time 5 "${metrics_headers[@]}" "$APP_URL/internal/metrics")"
grep -q '^ea_http_requests_total' <<< "$metrics" || {
  echo "release verification failed: application metrics are incomplete" >&2
  exit 1
}
grep -q '^ea_backup_last_validation_timestamp_seconds' <<< "$metrics" || {
  echo "release verification failed: backup validation metric is missing" >&2
  exit 1
}

if [[ "$REQUIRE_PROMETHEUS" == "true" ]]; then
  wait_for_endpoint "$PROMETHEUS_URL/-/ready"
fi

echo "production release verification passed"
