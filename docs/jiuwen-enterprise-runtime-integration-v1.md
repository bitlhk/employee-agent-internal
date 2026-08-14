# Jiuwen Enterprise Runtime Integration V1

Status: architecture baseline, not yet a production traffic switch.

## 1. Decision

The enterprise JiuwenClaw package `0.0.11n` must not directly replace the
customized Shanghai-1 runtime `0.2.3+ea.13`.

They are different product lines:

- Shanghai-1 is based on JiuwenSwarm `release_0.2.3` plus 28 Linggan commits.
- Enterprise `0.0.11n` is based on the `dev/enterprise_kub` line and reports
  JiuwenSwarm `0.1.10` package metadata.
- Enterprise provides Kubernetes scheduling, dynamic AgentServer instances,
  shared storage and service/session isolation.
- Shanghai-1 provides the EA-specific role scope, selected Skill rail, managed
  memory integration, signed MCP runtime identity, scheduler routing, A2A
  behavior and search recovery needed by the current product.

The target is therefore:

```text
Linggan account and SSO
        |
        v
Shanghai-1 EA control plane
  Identity / Adoption / Principal V2
  Role assets / Knowledge / Memory
  Governance / PEP / Evidence
        |
        v
EA Enterprise Runtime Adapter
  stable routing identity
  asset bundle bootstrap
  feature compatibility gate
  sticky rollout and fallback
        |
        v
Enterprise Jiuwen Gateway on Shanghai-3
        |
        v
Dynamic AgentServer pods on Shanghai-2 and Shanghai-3
```

EA remains the identity and authorization source of truth. Enterprise Jiuwen
identifiers are scheduling keys, not authorization claims.

## 2. Environment Roles

| Environment | Role |
| --- | --- |
| Shanghai-1 (`192.168.0.62`) | EA production, Linggan SSO entry, current customized runtime, production fallback |
| Shanghai-2 (`192.168.0.207`) | K3s worker, dynamic AgentServer compute |
| Shanghai-3 (`192.168.0.114`) | K3s control plane, enterprise Gateway/Manager, dynamic AgentServer compute, current PoC NFS |
| Local | Development and repeatable 150-account load fixtures; not production capacity evidence |
| Singapore | Keep as a later DR/secondary-region target; do not split the Shanghai training cohort across regions |

Shanghai-1 can reach Shanghai-2/3 over private SSH, so the VPC path exists. The
enterprise WebSocket business ports are not allowed by the current cloud
security policy, and the runtime Web service is only exposed through its cluster
Service/NodePort. Before canary traffic, provide a TLS-authenticated internal
WebSocket endpoint or allow a private, source-restricted service port from
`192.168.0.62`. An unrestricted public NodePort is not an acceptable production
integration path.

## 3. Identity Chain

The browser identity chain remains:

```text
Linggan registration/login
  -> shared users.id
  -> shared .linggan.top session cookie
  -> EA authenticateRequest
  -> claw_adoptions
  -> RuntimePrincipalV2
  -> authorization snapshot
```

The runtime mapping must be server-generated:

| EA authority | Enterprise runtime mapping |
| --- | --- |
| `userId` | opaque `runtimeUserId`; never email/phone |
| `adoptId` | stable adoption routing and workspace identity |
| `agentId` | stable enterprise `agent_id` |
| `roleTemplate` | runtime bot/role label and asset selection input |
| `sessionId` | stable conversation session; never shared across adoptions |
| `tenantId` / `organizationId` | governance and MCP authorization only; not inferred from enterprise `group_id` |

Recommended finite routing keys:

```text
runtimeGroupId   = ea_s<hash(adoptId) mod shardCount>
runtimeBotId     = <roleTemplate>
runtimeUserId    = <opaque user/adoption key>
runtimeServiceId = runtimeGroupId + "::" + runtimeBotId
runtimeAgentId   = runtimeUserId (with per-chat-bot-user session scope)
workspaceKey     = md5(runtimeGroupId + "::" + runtimeBotId + "::" + runtimeUserId)
```

The shard count is a capacity control. It is not an organization or permission
boundary. Changing it must not move an active conversation without an explicit
runtime binding migration.

The enterprise Manager must publish matching service and agent policies before
any binding becomes `ready`:

```text
service_id   = ${group_id}::${bot_id}
agent_id     = ${user_id}
workspace_dir = ${group_id}::${bot_id}::${user_id}
```

The checked-in `runtime:enterprise:configure` command creates or validates these
policies. It refuses silently divergent existing policies instead of overwriting
them. The Shanghai PoC validated this mapping end-to-end against enterprise
`0.0.11n`: the Gateway resolved the expected raw identifiers, hashed them for
runtime placement, and returned `chat.final` from a dynamically selected pod.

### Demo tenant decision

The Linggan public experience and training environment use one platform-owned
demo asset tenant:

```text
tenantId       = tn_linggan_finance
organizationId = org_linggan_finance
displayName    = 灵感金融
```

The free-text `company` collected during registration is lead/profile metadata.
It is not an authorization claim and must not decide tenant membership. This
removes the unsafe implication that two users typing the same company name may
share an enterprise authorization boundary.

The shared demo tenant contains only platform Reference Knowledge, Skill
templates, Mock MCP connections, demo Policy, and Golden Tasks. The following
remain isolated by `userId + adoptionId`:

- conversations and task state;
- Memory and generated files;
- workspace and runtime binding;
- approvals, idempotency receipts, Audit, and Evidence;
- all demo-side-effect records.

Real bank deployments use a separate enterprise tenancy mode backed by verified
SSO or administrator-managed organization membership. They must never infer
membership from the public registration `company` field.

## 4. Compatibility Matrix

| Capability | Enterprise `0.0.11n` | Current EA requirement | Result |
| --- | --- | --- | --- |
| Dynamic AgentServer scheduling | Supported | 150-person burst capacity | PASS |
| `service_id` / `agent_id` / `session_id` routing | Supported and direct IDs are preserved | Stable adoption isolation | PASS with EA-generated mapping |
| Shared persistent workspace | Shared NFS-backed workspace keys | Per-adoption Skill/files/history | PARTIAL; needs remote workspace mapping |
| Local absolute `project_dir` | Accepted as request input but refers to a path inside the pod | Shanghai-1 local workspace content | FAIL; never send Shanghai-1 absolute paths to the cluster |
| Role scope manifest | No `.linggan-role-scope.json` enforcement | Fail-closed Skill/MCP role scope | FAIL; port or add equivalent adapter |
| Selected Skill request rail | Only team-member configuration was found | Per-request selected Skill prompt and minimal tool exposure | FAIL; port required |
| Skill installation | Enterprise install APIs and per-tenant rows exist | EA default/optional Skill reconciliation | PARTIAL; needs asset bundle/bootstrap adapter |
| EA platform MCP | Generic/request-scoped MCP exists | Signed EA identity, role allowlist, platform gateways | FAIL; port required |
| Managed memory read | Native memory exists | EA-selected governed memory | PASS through EA prompt Context; native memory must stay disabled |
| Managed memory write | Native memory behavior differs | EA is sole writer with evidence/versioning | FAIL unless platform MCP write tools are restored |
| Per-request model choice | Runtime uses configured model; EA `model_name` is not consumed on the normal request path | EA automatic model routing | FAIL; use a model gateway or port request-level model selection |
| Session history | Enterprise session files on shared workspace | Existing Shanghai-1 history continuity | PARTIAL; new sessions work, old sessions require migration or sticky fallback |
| Generated files | Enterprise supports file transfer/MinIO | EA file list currently scans local workspace | FAIL; add remote artifact adapter |
| Cron | Enterprise routing exists | EA platform scheduler and ownership semantics | PARTIAL; keep EA scheduler for V1 |
| A2A/team | Enterprise team mode exists | Linggan A2A routing, output and governance semantics | PARTIAL; disable for first canary until tests pass |
| Search recovery | Enterprise has its own search tools | Linggan bounded search/cache/finalization fixes | UNKNOWN/PARTIAL; keep out of first canary |
| Sandbox | JiuwenBox sidecar supported | Isolated file/command execution | PASS after workspace and PEP tests |
| Governance/Evidence | Enterprise permissions are not EA Governance | EA PEP, approvals, idempotency and receipts | PASS only when enterprise capability calls return through EA gateways |

## 5. Required Adapter Boundaries

### 5.1 Runtime binding

Add a persistent per-adoption binding instead of deriving a new target on every
request:

```text
adoptId
runtimeProfile        standalone | enterprise-canary | enterprise
gatewayTarget
runtimeServiceId
runtimeAgentId
workspaceKey
assetSetFingerprint
boundAt
lastValidatedAt
```

The binding provides sticky sessions, controlled migration and immediate
rollback. Existing Shanghai-1 adoptions remain `standalone` until explicitly
validated.

### 5.2 Asset bundle bootstrap

EA must publish an immutable per-adoption bundle before the first enterprise
chat:

```text
IDENTITY.md
USER.md (managed safe projection)
.linggan-role-scope.json
selected/default Skill directories
platform MCP connection definition
asset-set.json with checksums
```

The cluster workspace location is resolved by the enterprise runtime. EA must
not pass a Shanghai-1 absolute filesystem path. Bootstrap is idempotent and
keyed by `assetSetFingerprint`.

For V1, use a custom AgentServer image based on the enterprise branch and port
only the required Linggan capabilities. Do not replay the entire 28-commit
stack blindly.

Required first ports:

1. role scope manifest and fail-closed MCP allowlist;
2. selected Skill request rail and disabled Skill tool filtering;
3. signed EA managed MCP runtime requests;
4. EA-managed memory write delegation;
5. stream cancellation and tool-call normalization;
6. model routing compatibility or a single model-gateway endpoint.

Search, native Cron and A2A patches can follow after the training lane is
stable.

### 5.2.1 Implemented enterprise compatibility overlay

The `ea/enterprise-0.0.11n` compatibility branch now provides the minimum
runtime overlay required by the PoC:

- request-scoped selected Skill disclosure without exposing local Skill paths;
- EA-managed memory writes while preserving native read/search behavior;
- short-lived runtime identity for EA-managed MCP requests;
- explicit registration of the OpenJiuwen streamable HTTP MCP client;
- delegation of native tool approval only for reserved EA gateway tools;
- AgentServer and Gateway overlay images that forward the required runtime
  environment.

EA provisions only three platform-owned MCP gateways into an enterprise
AgentServer:

```text
platform_tools       -> /api/internal/platform-tools/mcp
custom_mcp_gateway   -> /api/internal/custom-mcp/mcp
enterprise_mcp_gateway -> /api/internal/enterprise-mcp/mcp
```

The runtime receives no third-party endpoint or long-lived MCP credential.
For each request it obtains a short-lived token bound to runtime, adoption,
agent and audience. EA remains the authoritative PEP for tool visibility,
read/write classification, approval, idempotency and audit. Consequently an
existing unauthenticated Demo/Shadow MCP behind EA requires no developer-side
authentication change.

The first real canary used an active insurance-advisor adoption and called the
insurance customer-profile Mock MCP through the enterprise AgentServer and EA
enterprise MCP gateway. Tool discovery, role filtering, token verification,
downstream execution and final model synthesis completed successfully. This is
compatibility evidence, not a production traffic switch.

### 5.3 Capability execution

Enterprise AgentServers may read/compute locally. Enterprise business writes
must return a Capability Intent to the EA gateway:

```text
AgentServer intent
  -> EA Principal/current authorization intersection
  -> Governance Decision
  -> approval/idempotency/egress obligations
  -> EA MCP executor
  -> Business Receipt
```

This preserves the current GRACE PEP and avoids treating an enterprise pod's
local permission decision as enterprise authorization.

### 5.4 Model gateway

The enterprise PoC currently reaches Huawei MaaS directly and has already
observed upstream `429` responses under modest concurrency. More AgentServer
pods cannot fix model quota.

For the 150-person training target, route enterprise model calls through one
OpenAI-compatible model gateway that provides:

- provider concurrency budgets;
- queue limits and bounded waiting;
- retry only for safe transient failures;
- circuit breaking;
- automatic distribution across the approved Volcengine/Huawei pools;
- TTFT/TPOT/error/429 metrics;
- one stable model alias such as `ea-auto` for Jiuwen.

This is preferable to relying on EA's current per-request `model_name` field,
which enterprise `0.0.11n` does not consume on the normal chat path.

## 6. Rollout Cohorts

### Cohort A: existing production users

- Stay on Shanghai-1 customized runtime.
- No history or workspace migration during the training preparation window.
- Shanghai-1 is the fallback when enterprise readiness fails.

### Cohort B: local 150 synthetic insurance users

- Use for repeatable EA auth/adoption/Skill/MCP and business-task load tests.
- Route to enterprise only after the adapter and custom image are installed.
- These accounts do not prove Linggan SSO because local auth bypasses the
  production SSO bridge.

### Cohort C: real training users

- Register through Linggan.
- Complete the normal Linggan profile; `company` remains lead metadata only.
- Apply for the insurance-advisor adoption before the training day where
  possible, distributing workspace/Skill/MCP reconciliation over time.
- New validated adoptions enter `enterprise-canary`; unsupported features fall
  back before a conversation begins, never mid-conversation.

Use 5-10 real accounts to validate the complete Linggan SSO path. Creating 150
real Linggan accounts is not required for infrastructure load testing.

## 7. Load Validation

The target is not merely 150 logged-in users. Validate separate workloads:

1. `150` authenticated page/session reads;
2. `150` adoption/readiness checks;
3. `150` Skill inventory and role-asset reads;
4. `50`, `100`, then `150` concurrent minimal chats;
5. `50`, `100`, then `150` insurance Skill chats;
6. representative customer-profile and product MCP reads;
7. one governed write/approval flow at low concurrency;
8. reconnect, cancellation, timeout and node-loss recovery.

Acceptance gates for the training profile:

- no cross-user workspace, history, Skill or MCP leakage;
- no authentication or adoption mismatch;
- no unbounded queue growth;
- at least 99% successful minimal chat requests during the planned burst;
- P95 first visible response within the agreed training SLO;
- upstream `429` rate below 1% after model-gateway routing;
- a failed AgentServer pod is replaced without changing the user's adoption;
- unsupported enterprise features are routed to Shanghai-1 before execution;
- Governance DENY always proves that the executor was not called.

Pre-warm enough AgentServer capacity before the session. The current dynamic
pool's cold start and model quota behavior are not sufficient evidence for 150
simultaneous generations.

Run the enterprise Gateway/AgentServer lane separately from the EA HTTP and
authenticated business-read profiles:

```bash
EA_ENTERPRISE_LOAD_TEST_WS_URL=ws://127.0.0.1:19002/ws \
EA_ENTERPRISE_LOAD_TEST_STAGES=2,5,10 \
EA_ENTERPRISE_LOAD_TEST_GROUPS=1 \
pnpm load:enterprise-runtime
```

Increase `EA_ENTERPRISE_LOAD_TEST_GROUPS` only after every target node has the
same AgentServer image. One group measures per-AgentServer concurrency; several
groups also exercise dynamic service scheduling. The report records success,
TTFT and total latency per request under `data/load-tests/`.

The first two-node compatibility rehearsal proved logical user isolation even
when two users intentionally reused the same session ID, and recovered the
same user's conversation after deleting and recreating an AgentServer Pod.
However, the PoC pods currently mount the same RWX PVC root. Application-level
workspace keys separate users, but a compromised pod can enumerate other
workspace directories. Mock-data training may proceed with this limitation;
bank production requires storage-level isolation or a brokered file service.

### 7.1 Two-node PoC baseline (2026-08-15)

Minimal no-tool chats were executed against the enterprise Gateway after both
Shanghai nodes received the same AgentServer overlay image:

| Concurrent chats | Service groups | Success | TTFT P95 | Total P95 |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 1 | 2/2 | 10.2 s | 10.4 s |
| 5 | 1 | 5/5 | 11.6 s | 11.8 s |
| 10 | 1 | 10/10 | 69.0 s | 69.2 s |
| 10 | 2 | 10/10 | 35.4 s | 35.6 s |
| 10 | 4 | 10/10 | 20.5 s | 20.7 s |

Node CPU and memory remained low while the one-group 10-chat stage queued.
This demonstrates a per-service/runtime lane bottleneck rather than host memory
pressure. Horizontal service sharding materially improves latency, but this
baseline does not support 150 simultaneous generations. For training, prewarm
the cohort and stagger model exercises in groups. Do not claim 150-generation
capacity until a model gateway, additional warm service shards and the staged
50/100/150 profile all pass.

## 8. Singapore

Do not use Singapore as an ad-hoc load shard for the Shanghai training event.
That would require cross-region consistency for:

- Linggan session/auth state;
- runtime binding;
- conversation history;
- workspace and generated files;
- Knowledge/Memory versions;
- approvals, idempotency receipts and Audit.

Until those replication and data-residency decisions exist, Singapore should
remain a test/DR candidate. A later design can use region-pinned tenants and
asynchronous evidence backup rather than per-request cross-region balancing.

## 9. Implementation Order

1. Enable the platform-owned Linggan Finance demo tenant and validate that the
   Linggan SSO -> EA Principal V2 chain preserves per-user/adoption isolation.
2. Establish private Shanghai-1 -> enterprise Gateway connectivity with TLS or
   authenticated internal transport.
3. Apply the additive `runtime_agent_bindings` migration and connect the
   persistent binding to an enterprise routing envelope behind a
   disabled-by-default feature flag.
4. Build the enterprise-compatible AgentServer image with the minimum Linggan
   patch set and add asset bundle bootstrap.
5. Add remote history/file adapters and model-gateway integration.
6. Run the 150 local-account staged load profile and a small real-SSO canary.
7. Enable only new training adoptions, retaining Shanghai-1 as rollback.

## 10. Go/No-Go

Do not switch the training cohort to enterprise runtime until all are true:

- private connectivity is available;
- the Linggan Finance demo tenant is stable while user/adoption state remains isolated;
- selected Skill and role MCP tests pass in the enterprise image;
- per-adoption workspace and history isolation tests pass across both nodes;
- the model layer has enough aggregate quota or a tested gateway queue;
- generated files are retrievable through EA;
- rollback to Shanghai-1 is tested;
- the 100 and 150 staged profiles meet the agreed SLO.

The current enterprise deployment is a useful capacity PoC, not yet a drop-in
replacement for Shanghai-1.
