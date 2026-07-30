# Employee Agent Monitoring

This optional deployment runs pinned Prometheus and Grafana releases on the
application host. Both services bind to loopback. The Employee Agent server
exposes the provisioned Grafana dashboard through an administrator-authenticated,
read-only proxy; no monitoring port is exposed publicly.

## Start

```bash
cd /root/employee-agent
./scripts/install-observability-stack.sh
curl -fsS http://127.0.0.1:9090/-/ready
curl -fsS http://127.0.0.1:3000/api/health
```

For an existing deployment, also set `EA_MONITORING_ENABLED=true`,
`PROMETHEUS_URL=http://127.0.0.1:9090`, and
`GRAFANA_INTERNAL_URL=http://127.0.0.1:3000` in `.env`, then restart the EA
process with its normal deployment command.

For a new one-click installation, opt in explicitly:

```bash
curl -fsSL https://linggan.top/install.sh | EMPLOYEE_AGENT_MONITORING=1 bash
```

The default installation does not install either service and does not show the
administrator monitoring menu. Existing enterprise Prometheus can continue to
scrape `/internal/metrics`; the bundled stack is not required.

The installer uses Compose when available and falls back to equivalent
restricted Docker containers without installing additional host packages.

Inspect active alerts from an administrator workstation through an SSH tunnel:

```bash
ssh -L 9090:127.0.0.1:9090 root@application-host
```

Then open `http://127.0.0.1:9090/alerts` locally.

Administrators can view the provisioned operations dashboard from
`/admin` → `运行监控`. Grafana is anonymous only on its loopback listener; EA
still authenticates every proxied dashboard and data-query request as an
administrator.

The recording and alert rules implement the objectives documented in
`docs/service-level-objectives.md`. Release evidence is read from the bounded
deployment ledger, and restore RPO/RTO evidence is read from the latest
successful isolated restore report.

## Boundaries

- Metrics contain bounded operational categories and no user, Agent, conversation, document, filename, prompt, or credential labels.
- Prometheus retention is limited to 15 days or 5 GB, whichever is reached first.
- Grafana is provisioned as a read-only Viewer with login, signup, Explore,
  analytics, and built-in alerting disabled.
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
