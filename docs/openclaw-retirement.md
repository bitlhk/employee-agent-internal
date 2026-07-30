# OpenClaw Runtime Retirement

## Status

JiuwenSwarm is the only active岗位智能体 runtime. OpenClaw instances have been
removed from managed environments and new OpenClaw provisioning is rejected.

The first retirement phase keeps the old implementation files only as temporary
source history while removing their production execution paths:

- unknown and `lgc-*` adoption identifiers fail closed
- role provisioning and reconciliation reject OpenClaw
- OpenClaw chat WebSocket, recovery, WeChat bridge, and desktop proxy routes are
  not registered
- collaboration no longer calls the OpenClaw gateway
- desktop schedules use the JiuwenSwarm cron provider

## Compatibility Boundary

The `/api/claw/*` namespace, database tables, audit values, and shared modules
such as files, skills, MCP, memory, sandbox, notifications, and collaboration
are EA platform contracts. Their historical names do not imply an OpenClaw
runtime dependency and are not removed by this retirement.

Historical `openclaw` audit values may remain readable. They must never select a
live runtime.

## Follow-up Removal

After the JiuwenSwarm web, Feishu, schedule, Skill, MCP, sandbox, and desktop
smoke tests pass in managed environments:

1. Tag the last commit containing the dormant adapter.
2. Delete pure OpenClaw runtime modules, scripts, and tests.
3. Remove unreachable OpenClaw branches from mixed route modules.
4. Extract shared helpers such as cron preview calculation before deleting their
   former OpenClaw owner module.
