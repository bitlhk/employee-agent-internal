# Phase 3 Reliability And Capacity Plan

## Goal

Phase 3 makes the current single-node deployment measurable and operable before
introducing Redis, multiple application replicas, or Kubernetes. It does not
change runtime selection, Agent behavior, skill discovery, MCP authorization, or
sandbox policy.

## Scope

1. Add bounded Prometheus metrics for chat, runtime, MCP, sandbox, database pool,
   and background workers.
2. Give recurring background workers a shared start/stop contract so releases do
   not leave timers running while the HTTP server drains.
3. Extend the existing administrator system-health view with capacity, workers,
   metrics, and alert-delivery status.
4. Provide an optional Feishu alert dispatcher. Missing alert configuration is a
   visible disabled state, never an application startup failure.
5. Add a repeatable 10/30/50-concurrency load test and store its machine-readable
   result. The default scenario does not call paid models.

Off-site restore drills and large-module refactoring remain separate phases.

## Metric Contract

All labels are bounded enums. User IDs, Agent IDs, conversation IDs, tool names,
filenames, URLs, and model prompts are forbidden labels.

- Chat: request count, active requests, total duration, first-token duration;
  labels are `runtime` and `outcome`.
- Runtime: call count, active calls, and duration; runtime is `jiuwenswarm` or
  `openclaw`.
- MCP: call count, active calls, and duration; kind is `platform` or `custom`.
- Sandbox: execution count, active calls, and duration by bounded outcome.
- Database: pool configured limits, active checked-out connections, connection
  creation/errors, and queue pressure events.
- Workers: one-hot state, stop count, and stop duration by bounded worker name.

## Background Worker Contract

Each recurring worker returns an idempotent stop function. The supervisor records
its state and stops workers in reverse start order when server draining begins.
Stopping prevents new scheduled work. Existing HTTP/SSE work continues to use the
normal request and capacity drain windows.

Managed workers in this phase:

- application log retention
- cron result delivery
- external Agent health monitor
- Agent memory projection and cleanup
- knowledge index recovery
- audit DLQ drain
- adoption recycler

## Alerting

The first implementation polls local Prometheus alerts from a separate dispatcher
process and posts only state transitions to an approved Feishu bot webhook. The
webhook is supplied through `EA_ALERT_FEISHU_WEBHOOK_URL`; it is never returned to
the browser or written to logs. Alert delivery failure does not affect application
availability.

The administrator health page reports whether metrics, alerting, and workers are
ready. It does not expose Prometheus credentials or webhook addresses.

The release manager starts `employee-agent-alerts` only when `.env` contains an
official `https://open.feishu.cn` webhook. Validate a new channel before enabling
the long-running process:

```bash
node scripts/feishu-alert-dispatcher.mjs --test
node scripts/feishu-alert-dispatcher.mjs --once
```

## Capacity Calibration

The default load test exercises liveness, readiness, branding, and the built web
application at 10, 30, and 50 concurrent virtual users. It measures throughput,
error rate, and p50/p95/p99 latency without consuming model tokens.

Authenticated chat, MCP, and sandbox scenarios are opt-in and require explicit
credentials. They are run with small samples in local or dedicated test
environments, not as a 50-user production model storm.

Use `pnpm load:business` with `EA_BUSINESS_LOAD_TEST_COOKIE` and
`EA_BUSINESS_LOAD_TEST_ADOPT_ID` to calibrate authenticated health summary,
history, runtime, skill, and MCP reads. Model smoke requests are disabled by
default; enabling `EA_BUSINESS_LOAD_TEST_ENABLE_CHAT=1` and setting
`EA_BUSINESS_LOAD_TEST_CHAT_REQUESTS` sends at most five sequential prompts.
Reports are mode `0600` and never contain the supplied cookie or internal key.

Initial acceptance targets for the read-only platform scenario:

- HTTP error rate below 1 percent
- p95 below 1 second on the local baseline
- no capacity rejection or database pool error
- process RSS and event-loop lag return to baseline after the test

The measured report, not these provisional numbers, determines the production
training concurrency recommendation.
