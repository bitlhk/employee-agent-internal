# 150-Person Skill Training Capacity Runbook

## Scope

This runbook covers a hands-on class where up to 150 independent users browse,
upload, install, select, and execute Skills. It does not treat 150 attendees as
150 guaranteed simultaneous model generations; that capacity must be proven
against the configured model and MCP providers before the event.

## Runtime Controls

Recommended Shanghai training values for the 16 vCPU / 32 GB worker profile:

```dotenv
DB_CONNECTION_LIMIT=20
DB_MAX_IDLE=10
DB_QUEUE_LIMIT=300

EA_API_MAX_CONCURRENCY=300
EA_CHAT_HTTP_MAX_CONCURRENCY=60
EA_CHAT_HTTP_MAX_QUEUE=100
EA_CHAT_HTTP_QUEUE_WAIT_MS=120000

# Let attendees select “Automatic”; keep each turn on one model while spreading
# concurrent conversations across bounded provider lanes.
JIUWEN_AUTO_ROUTING_ENABLED=true
JIUWEN_AUTO_MODEL_POOL=deepseek-v4-flash:35:24,hy3:25:18,doubao-seed-2.1-pro:20:14,glm-5.2:15:12,openpangu-2.0-flash:5:8
JIUWEN_AUTO_MODEL_FAILURE_THRESHOLD=3
JIUWEN_AUTO_MODEL_CIRCUIT_MS=30000
JIUWEN_AUTO_MODEL_STICKY_MS=900000

# Keep workshop packages small. The product maximum remains 50 MB.
EA_SKILL_UPLOAD_MAX_BYTES=5242880
EA_SKILL_SCAN_CONCURRENCY=4
EA_SKILL_SCAN_MAX_QUEUE=200
EA_SKILL_INSTALL_CONCURRENCY=2
EA_SKILL_INSTALL_MAX_QUEUE=200
```

The Skill registry remains a serialized file-backed mutation boundary. The
200-request queues absorb a whole-class arrival burst, but they do not make
installation parallel. For the workshop, start uploads in three groups of
about 50 attendees, separated by one or two minutes. Do not raise install
concurrency to hide registry serialization; migrate the registry to a
transactional store before running sustained multi-EA-process writes.

Do not raise `EA_CHAT_HTTP_MAX_CONCURRENCY` until the real model/Skill stages
below pass. A larger number cannot create upstream MaaS or MCP quota.

The model-lane limits total 76 so the normal 60-request chat lane can spill
between providers without allowing one model to absorb the whole class. The
100-request waiting queue absorbs a 150-person start burst without turning it
into 150 simultaneous model calls. Confirm provider RPM/TPM/concurrency quota
before raising the active chat limit.

Each enterprise Jiuwen AgentServer service-shard pod requests 500m CPU and
1 GiB memory. Users do not each own a pod: the stable binding maps an adoption
to one of 16 finite shards per role, while `runtimeUserId` and `workspaceKey`
preserve user/adoption isolation inside the shard. A 150-person single-role
class therefore needs at most 16 AgentServer pods, spread across Shanghai 2 and
Shanghai 3, and fits the current two 16 vCPU / 32 GB workers. A multi-role event
must budget `active roles x 16` service pods separately.

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
5. Put the 150 short-lived session cookies in a mode-0600 load-test profile file.
6. Add `selectedSkillId` to each profile when validating one training Skill.

Do not cold-start all attendee runtimes concurrently. After account preparation,
send one short automatic-model request per profile with concurrency 1-2. This
warms the Jiuwen agent, workspace, Skill links, and MCP clients before the
rehearsal. A cancelled cold start must still return a terminal
`REQUEST_CANCELLED` response; the EA gateway must never wait for its full stream
timeout.

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
EA_LOAD_TEST_STAGES=10,50,100,150 \
EA_LOAD_TEST_STAGE_SECONDS=15 \
pnpm load:capacity

EA_BUSINESS_LOAD_TEST_URL=http://127.0.0.1:5180 \
EA_BUSINESS_LOAD_TEST_PROFILE_FILE=/root/ea-training-profiles.json \
EA_BUSINESS_LOAD_TEST_STAGES=25,50,100,150 \
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
EA_BUSINESS_LOAD_TEST_CHAT_MODEL=__auto \
EA_BUSINESS_LOAD_TEST_CHAT_MESSAGE='使用所选技能完成培训检查，只返回 TRAINING_OK。' \
pnpm load:training
```

Prewarm all profiles before the concurrent model stage:

```bash
EA_BUSINESS_LOAD_TEST_URL=http://127.0.0.1:5180 \
EA_BUSINESS_LOAD_TEST_PROFILE_FILE=/root/ea-training-profiles.json \
EA_BUSINESS_LOAD_TEST_STAGES=1 \
EA_BUSINESS_LOAD_TEST_STAGE_SECONDS=1 \
EA_BUSINESS_LOAD_TEST_ENABLE_CHAT=1 \
EA_BUSINESS_LOAD_TEST_CHAT_REQUESTS=150 \
EA_BUSINESS_LOAD_TEST_CHAT_CONCURRENCY=1 \
EA_BUSINESS_LOAD_TEST_CHAT_MODEL=__auto \
EA_BUSINESS_LOAD_TEST_CHAT_MESSAGE='只返回 PREWARM_OK。' \
pnpm load:training
```

Repeat at chat concurrency 25, 50, 75, 100, then 150 only after the preceding
stage passes. A 150-request start burst is admitted through the 60-active /
100-waiting policy; it does not imply 150 simultaneous model generations.

## Measured Shanghai Baseline

The 2026-08-15 control-plane rehearsal used 11 active independent
user/adoption profiles and repeated them to generate a 150-request start burst.
It validates admission, queueing, automatic model routing and both Shanghai
compute nodes. It does not yet validate 150 distinct runtime identities and
workspaces; that final gate must be repeated with 150 independent profiles.

| Scenario | Result |
| --- | --- |
| Authenticated business reads, 20 concurrent | 0 errors; 63.25 requests/s; p95 677.7 ms |
| Automatic model, 70-request burst | 70/70 completed; no queue loss |
| Automatic model, 100-request burst | 100/100 completed; maximum 32.8 s |
| Automatic model, 150-request burst / 11 profiles | 150/150 completed; first-byte p95 18.1 s; full-task p95 79.3 s; maximum 83.9 s |

The EA admission and model lanes accept a 150-request start burst with bounded
queueing. Independent runtime identity remains a separate gate even though pod
cardinality is bounded by the 16 service shards. Prewarm every attendee profile
in small batches, verify all 16 shards schedule, and assert that history,
workspace, Skill and MCP scope never cross adoption boundaries.

## Acceptance

- Read/navigation: error rate below 1%, p95 below 1.5 seconds at 150 users.
- Skill upload/install: no lost registry rows; no corrupt index; queue rejection below 1%.
- Skill execution: at least 98% completed streams and at least 95% expected Skill selection.
- Model: no sustained 429s; first-token p95 below 20 seconds.
- MCP: at least 98% success for every MCP used by the class.
- Host: memory below 80%, no OOM, no event-loop stall, no file-descriptor exhaustion.
- Governance: no unauthorized tool execution and complete audit identity per user.

## Event Operation

- Freeze deployments from the evening before the class until the exercises end.
- Use three waves of 50 for normal Skill calls and groups of 25 for upload,
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
ea_model_auto_selections_total
ea_model_auto_circuit_open
ea_model_active_requests
ea_model_requests_total
ea_model_ttft_seconds
ea_model_tpot_seconds
ea_chat_requests_total
ea_mcp_calls_total
```
