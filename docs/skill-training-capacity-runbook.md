# 100-Person Skill Training Capacity Runbook

## Scope

This runbook covers a hands-on class where up to 100 independent users browse,
upload, install, select, and execute Skills. It does not treat 100 attendees as
100 guaranteed simultaneous model generations; that capacity must be proven
against the configured model and MCP providers before the event.

## Runtime Controls

Recommended Shanghai training values after an 8 vCPU / 24-32 GB upgrade:

```dotenv
DB_CONNECTION_LIMIT=20
DB_MAX_IDLE=10
DB_QUEUE_LIMIT=300

EA_API_MAX_CONCURRENCY=300
EA_CHAT_HTTP_MAX_CONCURRENCY=60
EA_CHAT_HTTP_MAX_QUEUE=50
EA_CHAT_HTTP_QUEUE_WAIT_MS=60000

# Keep workshop packages small. The product maximum remains 50 MB.
EA_SKILL_UPLOAD_MAX_BYTES=5242880
EA_SKILL_SCAN_CONCURRENCY=4
EA_SKILL_SCAN_MAX_QUEUE=100
EA_SKILL_INSTALL_CONCURRENCY=2
EA_SKILL_INSTALL_MAX_QUEUE=100
```

Do not raise `EA_CHAT_HTTP_MAX_CONCURRENCY` until the real model/Skill stages
below pass. A larger number cannot create upstream MaaS or MCP quota.

JiuwenSwarm should run with at least 65,535 open files:

```ini
# systemctl edit jiuwenswarm
[Service]
LimitNOFILE=65535
```

Then run `systemctl daemon-reload` and restart JiuwenSwarm in a maintenance
window. Add 4-8 GB swap as OOM protection; swap is not usable capacity.

## Account Preparation

1. Create one account and one active `lgj-*` adoption per attendee. Never share accounts.
2. Assign the intended role before the rehearsal.
3. Pre-create the Jiuwen workspace and role-default Skill links.
4. Log in once and verify Skill registry, model selection, and runtime readiness.
5. Put the 100 short-lived session cookies in a mode-0600 load-test profile file.
6. Add `selectedSkillId` to each profile when validating one training Skill.

Example profile entry:

```json
{
  "adoptId": "lgj-training-001",
  "cookie": "<short-lived test session>",
  "selectedSkillId": "training-skill"
}
```

## Rehearsal Gates

Run platform and authenticated reads first:

```bash
EA_LOAD_TEST_URL=http://127.0.0.1:5180 \
EA_LOAD_TEST_STAGES=10,50,100 \
EA_LOAD_TEST_STAGE_SECONDS=15 \
pnpm load:capacity

EA_BUSINESS_LOAD_TEST_URL=http://127.0.0.1:5180 \
EA_BUSINESS_LOAD_TEST_PROFILE_FILE=/root/ea-training-profiles.json \
EA_BUSINESS_LOAD_TEST_STAGES=25,50,100 \
EA_BUSINESS_LOAD_TEST_STAGE_SECONDS=15 \
pnpm load:training
```

Real model requests are opt-in and may incur cost. Increase in stages and stop
when provider throttling, timeouts, or the SLO gate fails:

```bash
EA_BUSINESS_LOAD_TEST_URL=http://127.0.0.1:5180 \
EA_BUSINESS_LOAD_TEST_PROFILE_FILE=/root/ea-training-profiles.json \
EA_BUSINESS_LOAD_TEST_STAGES=25 \
EA_BUSINESS_LOAD_TEST_STAGE_SECONDS=5 \
EA_BUSINESS_LOAD_TEST_ENABLE_CHAT=1 \
EA_BUSINESS_LOAD_TEST_CHAT_REQUESTS=25 \
EA_BUSINESS_LOAD_TEST_CHAT_CONCURRENCY=10 \
EA_BUSINESS_LOAD_TEST_CHAT_MESSAGE='使用所选技能完成培训检查，只返回 TRAINING_OK。' \
pnpm load:training
```

Repeat at chat concurrency 25, 50, then 75 only after the preceding stage
passes. Run 100 only when the class explicitly requires 100 simultaneous
generations and the model provider confirms matching concurrency/RPM/TPM quota.

## Acceptance

- Read/navigation: error rate below 1%, p95 below 1.5 seconds at 100 users.
- Skill upload/install: no lost registry rows; no corrupt index; queue rejection below 1%.
- Skill execution: at least 98% completed streams and at least 95% expected Skill selection.
- Model: no sustained 429s; first-token p95 below 20 seconds.
- MCP: at least 98% success for every MCP used by the class.
- Host: memory below 80%, no OOM, no event-loop stall, no file-descriptor exhaustion.
- Governance: no unauthorized tool execution and complete audit identity per user.

## Event Operation

- Freeze deployments from the evening before the class until the exercises end.
- Use two waves of 50 for normal Skill calls and four groups of 25 for upload,
  sandbox, or MCP-heavy exercises.
- Stagger each group start by 30-60 seconds.
- Use one verified fast MaaS model and one paid fallback. Do not use free models
  as the primary classroom path.
- Keep Grafana, Prometheus, JiuwenSwarm logs, and the Skill queue metrics open.
- Prepare a preinstalled Skill exercise so training can continue if an external
  model or MCP provider is degraded.

Key metrics:

```text
ea_capacity_active{lane="chat_http"}
ea_capacity_queued{lane="chat_http"}
ea_capacity_rejections_total{lane="chat_http"}
ea_skill_work_active
ea_skill_work_queued
ea_skill_work_rejections_total
ea_chat_first_token_duration_seconds
ea_chat_requests_total
ea_mcp_calls_total
```
