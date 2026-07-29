# Employee Agent Monitoring

This deployment runs a pinned Prometheus release on the application host. It scrapes the loopback-only Employee Agent metrics endpoint and binds the Prometheus UI to loopback, so no monitoring port is exposed publicly.

## Start

```bash
cd /root/employee-agent
./scripts/install-prometheus-monitoring.sh
curl -fsS http://127.0.0.1:9090/-/ready
```

The installer uses Compose when available and falls back to an equivalent restricted Docker container without installing additional host packages.

Inspect active alerts from an administrator workstation through an SSH tunnel:

```bash
ssh -L 9090:127.0.0.1:9090 root@application-host
```

Then open `http://127.0.0.1:9090/alerts` locally.

## Boundaries

- Metrics contain bounded operational categories and no user, Agent, conversation, document, filename, prompt, or credential labels.
- Prometheus retention is limited to 15 days or 5 GB, whichever is reached first.
- Alert rules are evaluated locally. Feishu delivery is optional and uses a separate PM2 process, so alert polling does not share the main request lifecycle.
- `/internal/metrics` remains loopback-only when `METRICS_BEARER_TOKEN` is empty. If a token is enabled later, update the scrape job with a root-readable credentials file instead of embedding the token in this repository.

## Validate

```bash
docker compose run --no-deps --entrypoint /bin/promtool prometheus \
  check config /etc/prometheus/prometheus.yml
docker compose run --no-deps --entrypoint /bin/promtool prometheus \
  check rules /etc/prometheus/rules/employee-agent-alerts.yml
```

## Optional Feishu Delivery

Set `EA_ALERT_FEISHU_WEBHOOK_URL` in the deployment environment and start the
standalone dispatcher. The URL is never returned by the administrator API.

```bash
pm2 startOrReload ops/monitoring/ecosystem.alert-dispatcher.config.cjs \
  --only employee-agent-alerts --update-env
pm2 save
```

Without the variable, the system-health page reports alerting as not configured
and the dispatcher should not be started.
