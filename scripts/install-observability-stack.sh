#!/usr/bin/env bash
set -Eeuo pipefail

: "${APP_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
: "${GRAFANA_IMAGE:=grafana/grafana:13.1.1}"
: "${GRAFANA_CONTAINER:=employee-agent-grafana}"
: "${GRAFANA_VOLUME:=employee-agent-grafana-data}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

monitoring_dir="$APP_ROOT/ops/monitoring"
[[ -r "$monitoring_dir/docker-compose.yml" ]] || { echo "missing monitoring compose file" >&2; exit 1; }
[[ -r "$monitoring_dir/grafana/dashboards/employee-agent-overview.json" ]] || {
  echo "missing Grafana dashboard" >&2
  exit 1
}

frontend_url="$(grep '^FRONTEND_URL=' "$APP_ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
frontend_url="${frontend_url:-http://localhost:5180}"
grafana_public_root="${GRAFANA_PUBLIC_ROOT_URL:-${frontend_url%/}/ops/grafana/}"
export GRAFANA_PUBLIC_ROOT_URL="$grafana_public_root"

if docker compose version >/dev/null 2>&1; then
  docker compose -p employee-agent-monitoring -f "$monitoring_dir/docker-compose.yml" up -d prometheus grafana
elif command -v docker-compose >/dev/null 2>&1; then
  # Compose v1 cannot always recreate containers built from current OCI image
  # metadata. Replace only Grafana's container shell; its named data volume stays.
  grafana_id="$(docker-compose -p employee-agent-monitoring -f "$monitoring_dir/docker-compose.yml" ps -q grafana 2>/dev/null || true)"
  if [[ -n "$grafana_id" ]]; then
    docker container stop "$grafana_id" >/dev/null
    docker container rm "$grafana_id" >/dev/null
  fi
  docker-compose -p employee-agent-monitoring -f "$monitoring_dir/docker-compose.yml" up -d prometheus grafana
else
  APP_ROOT="$APP_ROOT" "$APP_ROOT/scripts/install-prometheus-monitoring.sh"
  docker volume inspect "$GRAFANA_VOLUME" >/dev/null 2>&1 || docker volume create "$GRAFANA_VOLUME" >/dev/null
  if docker container inspect "$GRAFANA_CONTAINER" >/dev/null 2>&1; then
    docker container rm -f "$GRAFANA_CONTAINER" >/dev/null
  fi
  if ! docker image inspect "$GRAFANA_IMAGE" >/dev/null 2>&1; then
    docker pull "$GRAFANA_IMAGE" >/dev/null
  fi
  docker create \
    --name "$GRAFANA_CONTAINER" \
    --network host \
    --restart unless-stopped \
    --read-only \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --env GF_SERVER_HTTP_ADDR=127.0.0.1 \
    --env GF_SERVER_HTTP_PORT=3000 \
    --env "GF_SERVER_ROOT_URL=$grafana_public_root" \
    --env GF_SERVER_SERVE_FROM_SUB_PATH=true \
    --env GF_SECURITY_ALLOW_EMBEDDING=true \
    --env GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION=true \
    --env GF_AUTH_ANONYMOUS_ENABLED=true \
    --env GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
    --env GF_AUTH_ANONYMOUS_HIDE_VERSION=true \
    --env GF_AUTH_BASIC_ENABLED=false \
    --env GF_AUTH_DISABLE_LOGIN_FORM=true \
    --env GF_USERS_ALLOW_SIGN_UP=false \
    --env GF_USERS_ALLOW_ORG_CREATE=false \
    --env GF_EXPLORE_ENABLED=false \
    --env GF_ANALYTICS_REPORTING_ENABLED=false \
    --env GF_ANALYTICS_CHECK_FOR_UPDATES=false \
    --env GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false \
    --env GF_UNIFIED_ALERTING_ENABLED=false \
    --env GF_PATHS_LOGS=/var/lib/grafana/logs \
    --env GF_PATHS_PLUGINS=/var/lib/grafana/plugins \
    --mount "type=volume,src=$GRAFANA_VOLUME,dst=/var/lib/grafana" \
    --mount "type=bind,src=$monitoring_dir/grafana/provisioning/datasources,dst=/etc/grafana/provisioning/datasources,readonly" \
    --mount "type=bind,src=$monitoring_dir/grafana/provisioning/dashboards,dst=/etc/grafana/provisioning/dashboards,readonly" \
    --mount "type=bind,src=$monitoring_dir/grafana/dashboards,dst=/var/lib/grafana/dashboards,readonly" \
    "$GRAFANA_IMAGE" >/dev/null
  docker start "$GRAFANA_CONTAINER" >/dev/null
fi

for _attempt in $(seq 1 60); do
  prometheus_ready=false
  grafana_ready=false
  curl -fsS --max-time 3 http://127.0.0.1:9090/-/ready >/dev/null 2>&1 && prometheus_ready=true
  curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1 && grafana_ready=true
  if [[ "$prometheus_ready" == "true" && "$grafana_ready" == "true" ]]; then
    echo "Employee Agent monitoring is ready."
    echo "  Prometheus: http://127.0.0.1:9090"
    echo "  Grafana:    http://127.0.0.1:3000"
    echo "  EA route:   ${grafana_public_root}"
    exit 0
  fi
  sleep 2
done

echo "Monitoring services did not become ready" >&2
exit 1
