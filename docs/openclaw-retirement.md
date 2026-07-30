# OpenClaw Runtime Retirement

## Status

JiuwenSwarm is the only active岗位智能体 runtime. OpenClaw instances have been
removed from managed environments and new OpenClaw provisioning is rejected.

The runtime retirement is complete:

- unknown and `lgc-*` adoption identifiers fail closed
- role provisioning and reconciliation reject OpenClaw
- OpenClaw chat, WebSocket, recovery, WeChat bridge, cron, desktop proxy, and
  provisioning implementations have been removed
- collaboration no longer calls the OpenClaw gateway
- desktop schedules use the JiuwenSwarm cron provider

## Compatibility Boundary

The `/api/claw/*` namespace, database tables, audit values, and shared modules
such as files, skills, MCP, memory, sandbox, notifications, and collaboration
are EA platform contracts. Their historical names do not imply an OpenClaw
runtime dependency and are not removed by this retirement.

Historical `openclaw` audit values, database records, file formats, and desktop
request header aliases remain readable where required for compatibility. They
must never select a live runtime.

## Regression Gate

Changes to runtime routing must keep the JiuwenSwarm web, Feishu, schedule,
Skill, MCP, sandbox, and desktop smoke tests green. Reintroducing an OpenClaw
execution or fallback path requires a new architecture review and an explicit
runtime lifecycle plan.
