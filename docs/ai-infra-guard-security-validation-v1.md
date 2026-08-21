# GRACE AI-Infra-Guard Security Validation V1

## Scope

GRACE uses Tencent AI-Infra-Guard as an asynchronous security assessment tool. It is not placed in the real-time chat path and does not replace GRACE runtime authorization, Eligibility, tool policy, approval, or Receipt controls.

| Capability | Tool | Mode | Current boundary |
|---|---|---|---|
| Skill source scan | `aig-skill-scan` | asynchronous observe | New uploads and explicit existing-inventory backfill |
| MCP source scan | `aig-mcp-scan` | asynchronous observe | Administrator uploads the corresponding source ZIP; no MCP credential or remote tool invocation |
| Agent red team | `aig-agent-scan` | controlled offline validation | Isolated test Agent only; explicit server-side enablement required |
| Prompt/model evaluation | `AIG-PromptSecurity` | not deployed | Not reported as an active capability |

The configured evaluator model receives the source or attack prompts needed by these scans. Do not scan content that is not permitted to leave its current trust boundary.

## Existing Skill Backfill

The administrator starts backfill from `管理后台 -> 安全审计 -> 安全验证`. The job is asynchronous, concurrency-limited, fingerprint-aware, and does not block installed Skills while it runs. Missing legacy source paths are reported as skipped rather than treated as successful scans.

## MCP Source Scan

Open `企业连接器`, choose `安全扫描`, and upload a ZIP containing the source corresponding to that MCP server. The package is antivirus-checked and safely extracted before `aig-mcp-scan` runs. Findings are assessment evidence only; V1 does not automatically change the connector lifecycle.

## Isolated Agent Red Team

Never target an ordinary production adoption. Prepare a dedicated test tenant/adoption without production data and configure:

```bash
EA_AGENT_REDTEAM_ENABLED=true
EA_AGENT_REDTEAM_ISOLATED_TARGET=true
EA_AGENT_REDTEAM_ADOPT_ID=<isolated-adopt-id>
EA_AGENT_REDTEAM_TARGET_LABEL="Isolated wealth-agent security target"
EA_AGENT_REDTEAM_BASE_URL=http://127.0.0.1:5180
```

Then run:

```bash
pnpm security:agent:redteam
```

The default run uses GRACE restricted experience mode. Full-capability mode requires the additional explicit `EA_AGENT_REDTEAM_FULL_CAPABILITY_MODE=true` and must only be used in an isolated environment with non-production tools and data.

The generated provider YAML contains the internal key only while the process is running and is deleted afterward. The full report is stored with restricted permissions under `data/security-assessments/agent-redteam/`; the admin UI receives only normalized status and counts.

## Status Meaning

- `已执行`: deterministic control runs in the actual request path.
- `部分覆盖`: monitoring or validation exists but does not cover or block the complete path.
- `已验证`: the relevant asynchronous assessment completed without a reported finding requiring review.
- `存在风险`: an assessment found a high-risk issue; this is not the same as proof of exploitability.
- `待接入` or `未启用`: the capability must not be presented as active.

There is intentionally no overall security score. Provider health, assessment results, and runtime protection are separate facts.
