# OpenClaw Runtime Patches

This document records the non-upstream OpenClaw runtime patches used by Workforce Agent Platform.

The patches are operationally important. When OpenClaw or its bundled Codex runtime is reinstalled or upgraded, these files may be overwritten and must be rechecked.

## Current Patch Inventory

| Patch | Environment symptom if missing | Patched package | Patched file | Saved patch |
|---|---|---|---|---|
| WSS assistant delta streaming | WSS chat connects, but assistant text appears late, nearly all at once, or duplicates the terminal answer after deltas | `@openclaw/codex` runtime package under `~/.openclaw/npm/projects` | `2026.6.1`: `run-attempt-DM53zFlW.js`; `2026.6.8`: `run-attempt-D_q-VrpR.js` | Environment backup patch or runtime `.bak-assistant-delta-*` copy |
| Configured MCP server projection | Codex agent cannot see HTTP MCP servers configured in `openclaw.json` | global `openclaw@2026.6.1` package | `dist/codex-mcp-config-DiJtIU8m.js` | `~/.openclaw/patches/openclaw-2026.6.1-include-configured-mcp-servers.patch` |

## Patch 1: WSS Assistant Delta Streaming

### Purpose

OpenClaw WSS can connect successfully while still not providing a good streaming experience. In the unpatched `@openclaw/codex@2026.6.1` runtime, assistant deltas may not be emitted as `stream: "assistant"` events during the run. The UI then receives the terminal assistant text near the end, which feels non-streaming.

The patch changes the Codex run projector so that:

- every assistant delta immediately emits an agent event with `stream: "assistant"`;
- the projector records `assistantDeltaStreamed = true`;
- final terminal assistant text is only emitted when no assistant delta has already been streamed, avoiding duplicate final output.

### Known Good Local Path

Local test environment:

```bash
/home/ubuntu/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openclaw/codex/dist/run-attempt-DM53zFlW.js
```

Singapore test environment before patch:

```bash
/root/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openclaw/codex/dist/run-attempt-DM53zFlW.js
```

### Verification

Compare the runtime file against the official package or compare environment hashes.

Known observations from 2026-06-16:

- local runtime file differs from official `@openclaw/codex@2026.6.1`;
- Singapore runtime file matched official `@openclaw/codex@2026.6.1`;
- local WSS chat streamed correctly;
- Singapore WSS chat connected but did not show the same streaming behavior.

Expected diff shape:

- add `assistantDeltaStreamed` state;
- emit `stream: "assistant"` on assistant delta;
- suppress terminal assistant text when assistant deltas were already emitted.

### Operational Note

Restart OpenClaw gateway after applying this patch:

```bash
openclaw gateway restart
```

Restart EA if it keeps a stale WS connection or process state:

```bash
pm2 restart employee-agent
```

## Patch 2: Configured MCP Server Projection

### Purpose

Workforce Agent Platform registers enterprise MCP tools in `~/.openclaw/openclaw.json` under `mcp.servers`. The Codex app-server path must receive those configured MCP servers; otherwise the UI may show MCP tools while the running Codex agent cannot actually call them.

The patch changes OpenClaw MCP config generation so that:

- `cfg.mcp.servers` is normalized;
- enabled configured MCP servers are converted to Codex MCP config;
- configured MCP servers are merged with bundle MCP servers.

### Known Good Local Path

Local test environment:

```bash
/home/ubuntu/.npm-global/lib/node_modules/openclaw/dist/codex-mcp-config-DiJtIU8m.js
```

For root/global installs the path may be:

```bash
/usr/lib/node_modules/openclaw/dist/codex-mcp-config-DiJtIU8m.js
```

or:

```bash
/root/.npm-global/lib/node_modules/openclaw/dist/codex-mcp-config-DiJtIU8m.js
```

### Verification

Known local diff against official `openclaw@2026.6.1`:

- import `normalizeConfiguredMcpServers`;
- add `buildCodexConfiguredMcpServersConfig(cfg)`;
- merge configured MCP servers into `mcpServers` during Codex MCP config construction.

Operational symptom if missing:

- HTTP MCP proxies are running;
- `openclaw.json` contains `mcp.servers`;
- EA MCP tools page may show tools;
- Codex agent still cannot see or call those MCP servers.

## Upgrade Guidance

Do not assume these patches survive any of the following:

- `npm install -g openclaw`;
- OpenClaw version upgrade;
- `openclaw setup`;
- deleting `~/.openclaw/npm/projects/openclaw-codex-*`;
- OpenClaw reinstalling bundled `@openclaw/codex`.

Before upgrading:

1. Back up `~/.openclaw/openclaw.json`.
2. Back up current patched files.
3. Save or refresh patch files under `~/.openclaw/patches`.
4. Upgrade in the Singapore test environment first.
5. Verify WSS streaming and MCP visibility before touching local or Shanghai.

After upgrading:

1. Check whether upstream already includes the behavior.
2. If not, reapply the patches.
3. Restart OpenClaw gateway.
4. Restart EA.
5. Run one WSS streaming test and one MCP tool visibility/call test.

## Environment Baseline

As of 2026-06-16:

| Environment | OpenClaw | WSS streaming patch | MCP projection patch | Notes |
|---|---|---|---|---|
| Local | `2026.6.1` | Applied in `@openclaw/codex` runtime | Applied in global OpenClaw package | WSS streaming observed OK |
| Singapore test | `2026.6.1` | Not applied before sync | Needs verification | WSS connected but streaming behavior differed from local |
| Shanghai | Needs verification before upgrade | Needs verification | Needs verification | Production-like environment; do not upgrade first |

### Singapore 2026.6.8 Check (2026-06-17)

Singapore was upgraded to:

- `openclaw@2026.6.8`
- `@openclaw/codex@2026.6.8`
- `@openclaw/brave-plugin@2026.6.8`

Post-upgrade status:

- Gateway starts and `openclaw gateway status --deep` is OK.
- Codex/GPT-5.5 model call works.
- `bond_quote_parse` and `group_insurance_audit` streamable-http MCPs expose tools.
- `credential_skills` fails because its adapter upstream
  `http://127.0.0.1:8005` is unreachable; this is not an OpenClaw 2026.6.8
  regression.

The Codex runtime bundle changed file names. The WSS assistant delta patch now
targets:

```text
~/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openclaw/codex/dist/run-attempt-D_q-VrpR.js
```

OpenClaw/Codex 2026.6.8 already has assistant partial callbacks, but still emits
the final terminal assistant text as another `stream: "assistant"` event. We still
need the downstream guard:

- record run ids that emitted assistant partial/delta text;
- when finalizing the run, skip terminal assistant text emission if that run
  already streamed assistant partials.

Backup created before patch:

```text
run-attempt-D_q-VrpR.js.bak-assistant-delta-202606172052
```

After applying this patch and restarting the gateway, a GPT-5.5 smoke run
completed successfully.

### Local 2026.6.8 Check (2026-06-17)

Local test environment was upgraded to:

- `openclaw@2026.6.8`
- `@openclaw/codex@2026.6.8`

Post-upgrade status:

- Gateway starts and `openclaw gateway status --deep` reports CLI/Gateway
  `2026.6.8`.
- Weixin provider starts all configured local accounts.
- GPT-5.5 smoke run with `trial_lgc-ppstsl9ddr` completed successfully.
- The WSS assistant delta guard was applied to the same 2026.6.8 Codex runtime
  file as Singapore:

```text
~/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openclaw/codex/dist/run-attempt-D_q-VrpR.js
```

Backup created before patch:

```text
run-attempt-D_q-VrpR.js.bak-assistant-delta-202606172101
```

Known non-blocking local warnings after upgrade:

- `@openclaw/brave-plugin` remains on `2026.5.12` because the local plugin
  install index has conflicting metadata; current Codex/EA streaming verification
  does not depend on Brave.
- `wealth_assistant_customer` and `wealth_assistant_product` still warn about
  missing `OPENCLAW_AGENT_ID` in global status because those MCP headers are
  intended to be supplied per agent/request path.

## Recommended Policy

Treat these as temporary downstream patches until confirmed fixed upstream.

For repeatable operations, keep the patch files in environment backups and reference this document during:

- OpenClaw upgrade;
- environment rebuild;
- new runtime host provisioning;
- migration between local, Singapore, and Shanghai.

Longer term, move these into an explicit post-install patch script or upstream them into OpenClaw so runtime behavior is reproducible.
