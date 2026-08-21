# GRACE AI-Infra-Guard Skill Scan Integration

This integration runs Tencent's `aig-skill-scan` and `aig-mcp-scan` as isolated,
internal release-time scanners. It is not part of the Agent request path and does not
replace GRACE authorization, Eligibility, Policy, or release decisions.

The reviewed upstream source and package version are pinned in
`upstream.json`. Changing either requires a fresh scanner acceptance run.

Based on Tencent Zhuque Lab AI-Infra-Guard:
https://github.com/Tencent/AI-Infra-Guard

The upstream scanner is licensed under Apache-2.0. See its `LICENSE` and
`NOTICE` before redistribution.

## Local setup

```bash
python3 -m venv ~/.venvs/aig-skill-scan
~/.venvs/aig-skill-scan/bin/pip install /home/ubuntu/ai-infra-guard/skill-scan
~/.venvs/aig-skill-scan/bin/pip install /home/ubuntu/ai-infra-guard/mcp-scan
pm2 start integrations/ai-infra-guard-skill-scan/ecosystem.config.cjs.example
curl http://127.0.0.1:18920/healthz
```

EA integration is observation-only by default. Enable it explicitly:

```bash
EA_SKILL_SECURITY_SCANNER_ENABLED=true
EA_SKILL_SECURITY_SCANNER_URL=http://127.0.0.1:18920
EA_SKILL_SECURITY_SCANNER_MODE=observe
```

The scanner reads its model configuration from server-side environment
variables or `AIG_SKILL_SCAN_MODEL_ENV_PATH`. Credentials are never written to
Skill metadata, scan findings, or logs.

MCP V1 accepts source archives only and performs static analysis. It does not
receive production MCP credentials and does not invoke remote MCP tools.

Agent red-team execution is deliberately not exposed by this HTTP wrapper.
GRACE runs `aig-agent-scan` through the controlled
`pnpm security:agent:redteam` operator command, which requires an explicitly
marked isolated target. See `docs/ai-infra-guard-security-validation-v1.md`.
