#!/usr/bin/env bash
set -Eeuo pipefail

: "${APP_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
: "${PROMETHEUS_IMAGE:=prom/prometheus:v3.13.1}"
: "${PROMETHEUS_CONTAINER:=employee-agent-prometheus}"
: "${PROMETHEUS_VOLUME:=employee-agent-prometheus-data}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

monitoring_dir="$APP_ROOT/ops/monitoring"
[[ -r "$monitoring_dir/prometheus.yml" ]] || { echo "missing Prometheus configuration" >&2; exit 1; }
[[ -r "$monitoring_dir/rules/employee-agent-alerts.yml" ]] || { echo "missing Prometheus alert rules" >&2; exit 1; }

if docker compose version >/dev/null 2>&1; then
  docker compose -p employee-agent-monitoring -f "$monitoring_dir/docker-compose.yml" up -d prometheus
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose -p employee-agent-monitoring -f "$monitoring_dir/docker-compose.yml" up -d prometheus
else
  docker volume inspect "$PROMETHEUS_VOLUME" >/dev/null 2>&1 || docker volume create "$PROMETHEUS_VOLUME" >/dev/null
  if docker container inspect "$PROMETHEUS_CONTAINER" >/dev/null 2>&1; then
    docker container rm -f "$PROMETHEUS_CONTAINER" >/dev/null
  fi
  docker pull "$PROMETHEUS_IMAGE" >/dev/null
  docker create \
    --name "$PROMETHEUS_CONTAINER" \
    --network host \
    --restart unless-stopped \
    --read-only \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --mount "type=bind,src=$monitoring_dir/prometheus.yml,dst=/etc/prometheus/prometheus.yml,readonly" \
    --mount "type=bind,src=$monitoring_dir/rules,dst=/etc/prometheus/rules,readonly" \
    --mount "type=volume,src=$PROMETHEUS_VOLUME,dst=/prometheus" \
    "$PROMETHEUS_IMAGE" \
    --config.file=/etc/prometheus/prometheus.yml \
    --storage.tsdb.path=/prometheus \
    --storage.tsdb.retention.time=15d \
    --storage.tsdb.retention.size=5GB \
    --web.listen-address=127.0.0.1:9090 >/dev/null
  docker start "$PROMETHEUS_CONTAINER" >/dev/null
fi

for _attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:9090/-/ready >/dev/null 2>&1; then
    echo "Prometheus monitoring is ready on http://127.0.0.1:9090"
    exit 0
  fi
  sleep 2
done

echo "Prometheus did not become ready" >&2
exit 1
