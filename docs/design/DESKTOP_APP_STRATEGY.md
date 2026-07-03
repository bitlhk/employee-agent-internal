# Employee Agent Desktop Strategy

Last updated: 2026-06-06

## Executive Summary

Employee Agent should treat the desktop app as an enterprise edge client, not a forked product.

The recommended direction is:

1. Keep the current Employee Agent web service and customer-owned backend as the source of truth.
2. Build a cross-platform Electron desktop shell that reuses the existing web UI.
3. Add local capabilities gradually through a narrow, audited desktop bridge.
4. Only add a managed local runtime when a customer truly needs intranet, local-file, or offline workflows.

This avoids destabilizing the current web platform while delivering the concrete advantages of a desktop agent: controlled access to local files, authenticated browser sessions, private-network resources, OS-level workflows, and optional desktop-side transport optimizations where they are proven to help.

## Why Desktop Matters

Recent products such as Hermes Desktop and Marvis show a clear pattern: user experience improves when the agent can operate closer to the user's actual working environment.

For Employee Agent, the main value is not simply packaging the website as an app. The value is:

- Access to documents and internal URLs that cloud sandboxes cannot reach.
- Lower-friction login and session persistence.
- Better file open/download/upload workflows.
- Optional SSH/tunnel access to private enterprise runtime.
- Local diagnostics and logs for support.
- Future local runtime support for banking and enterprise intranet deployments.

The browser/web version remains necessary for management, permissions, audit,
team collaboration, and tenant or department-level operations.

## Hermes Desktop Reference Points

The Hermes Desktop codebase is useful as an architectural reference. The most relevant patterns are:

- Electron main/preload/renderer separation.
- Local mode and remote backend mode.
- SSH tunnel and remote gateway support.
- Main-process streaming proxy as an optional transport pattern.
- Secure preload API instead of exposing Node.js to the renderer.
- Local session/cache support.
- Health diagnostics and log collection.
- Auto-update and packaged installers.
- Security tests around Electron configuration.

Reference files in the local copy:

- `/home/ubuntu/reference/hermes-desktop/src/main/index.ts` — IPC handler registration, `send-message` flow, renderer crash recovery
- `/home/ubuntu/reference/hermes-desktop/src/main/hermes.ts` — API URL selection, Node.js streaming request, abort handling, accurate `Content-Length`, desktop session id, empty-stream probe, and `webContents.send` chunk forwarding
- `/home/ubuntu/reference/hermes-desktop/src/preload/index.ts` — `onChatChunk`/`onChatDone` bridge pattern, removeListener cleanup
- `/home/ubuntu/reference/hermes-desktop/src/main/ssh-tunnel.ts` — `ssh -N -L localPort:127.0.0.1:remotePort`, tunnel lifecycle, local port probing, `/health` check
- `/home/ubuntu/reference/hermes-desktop/src/main/ssh-remote.ts` — SSH exec for remote files, skills, memory, models, sessions, logs, gateway start/stop
- `/home/ubuntu/reference/hermes-desktop/src/main/gateway-ports.ts` — per-profile local port allocation
- `/home/ubuntu/reference/hermes-desktop/src/main/config-health.ts`
- `/home/ubuntu/reference/hermes-desktop/src/main/session-cache.ts`
- `/home/ubuntu/reference/hermes-desktop/tests/electron-security.test.ts`

The goal is to learn from the structure, not copy the product model wholesale. Hermes is more local-runner oriented; Employee Agent is private-deployment enterprise software plus OpenClaw governance.

Hermes Desktop is MIT licensed, so a prototype fork is legally practical as long
as the license notice is preserved. That makes it a reasonable acceleration path
for validation, but not automatically the best long-term product foundation.

Important difference: the current Employee Agent web chat is not a plain browser
SSE-only client. It already has a WebSocket-first path, HTTP SSE fallback,
stream truncation recovery, canonical DB reconciliation, and idle watchdogs. A
desktop main-process proxy can still be valuable, but it must be introduced as a
measured transport adapter rather than assumed to be faster in every scenario.

### Why Hermes Feels Fast — And What It Means For Us

Hermes Desktop 的速度和稳定性不是来自 Electron 本身，而是来自一组主进程能力：

```
Hermes SSH mode:
  Electron renderer
    -> IPC
      -> Electron main
        -> ssh -N -L localPort:127.0.0.1:remotePort user@host
        -> http://127.0.0.1:localPort/v1/chat/completions
        -> remote hermes-agent gateway

Remote management:
  Electron main
    -> ssh exec
      -> read/write remote skills, env, config, memory, sessions, logs
```

代码层面看，Hermes 至少做了这些事：

- SSH mode 下 `getApiUrl()` 返回 `http://127.0.0.1:<localPort>`，远端 runtime 被映射成本机 endpoint。
- `startSshTunnel()` 使用 `ssh -N -L <localPort>:127.0.0.1:<remotePort>`，并带 `ExitOnForwardFailure`、keepalive、本地端口探测、`/health` 校验。
- `sendMessageViaApi()` 在主进程用 Node.js `http/https.request` 发流式请求，设置准确 `Content-Length`，处理 abort，转发 chunk，生成稳定桌面 session id，并在空流时 probe 非流式请求拿真实错误。
- `ssh-remote.ts` 不把所有远程管理都塞进 REST，而是用 SSH exec 管远端文件、技能、模型配置、会话、日志、memory 和 gateway 生命周期。

所以 Hermes 的“快”不只是“连 localhost”，而是 **localhost gateway + 主进程网络栈 + SSH 远端管理 + 本地缓存/健康检查** 这几件事叠加。

**Employee Agent 是私有化部署产品**，数据在客户自己的 MySQL 里，后端跑在客户自己的服务器上。因此连接延迟取决于部署位置：

| 场景 | 连接方式 | 速度特征 |
|------|---------|---------|
| 用户在公司内网，后端也在内网 | 局域网直连 | 延迟极低，天然接近 Hermes |
| 用户在外网远程办公，后端在公司内网 | 需要 VPN 或 SSH 隧道穿透 | SSH 隧道的核心价值场景 |
| 后端部署在云服务器（阿里云/AWS 等） | 公网 HTTPS/WebSocket | 延迟取决于网络距离 |

对大多数企业客户（内网部署），桌面版的速度提升空间本来就有限——局域网延迟已经很低。桌面版真正的价值是：**在用户不在内网时，通过 SSH 隧道提供稳定的穿透访问**，以及本地文件、OS 集成、睡眠唤醒自动重连等浏览器做不到的能力。

### Alternative: Hermes-Derived Desktop Prototype

There is a credible shortcut: start from Hermes Desktop, replace branding and
entry configuration, point it at OpenClaw/Employee Agent, and then gradually add
Employee Agent governance.

This is viable for a **prototype** because Hermes already has the hardest
desktop transport pieces:

- Electron packaging and cross-platform desktop structure.
- SSH localhost gateway mode.
- Main-process streaming request handling.
- Session cache and health checks.
- Remote logs/config/runtime operations over SSH.
- Mature desktop UX patterns around runtime profiles.

The risk is product ownership drift. Hermes is built around a personal/local
runtime mental model. Employee Agent needs enterprise governance:

- user identity and agent ownership
- tenant/department boundaries
- role-based tool and MCP policy
- audit trails
- collaboration tasks
- skill/tool marketplace governance
- admin-side observability

If the fork becomes the main codebase too early, we would spend a long time
backfilling enterprise governance into a desktop product that was not designed
around it. The safer framing is:

```
Short-term:
  fork/customize Hermes Desktop to validate desktop speed, SSH localhost mode,
  installer, and runtime profile UX.

Medium-term:
  keep Employee Agent backend as source of truth; make the desktop client call
  Employee Agent APIs for user, agent, policy, audit, sessions, and tools.

Long-term:
  either keep the Hermes-derived shell if integration remains clean, or migrate
  the proven pieces into apps/desktop while preserving Employee Agent ownership.
```

The decision should be based on integration friction, not preference. If a
Hermes-derived prototype can connect to Employee Agent/OpenClaw with a thin
adapter and without duplicating governance logic, it is a strong Phase 0 path.
If it requires invasive rewrites across auth, session, tools, and UI state, then
building `apps/desktop` directly around the current web UI is cleaner.

#### Phase 0 Variant: Hermes Fork Directly Connected To OpenClaw

The fastest technical prototype is not to connect Hermes to Employee Agent
first. It is to connect a Hermes-derived desktop directly to OpenClaw, while
keeping Employee Agent untouched.

The first implementation should prefer OpenClaw's OpenAI-compatible HTTP
endpoint before replacing Hermes transport with raw Gateway WebSocket:

```
Hermes-derived Desktop
  -> Electron main
  -> SSH tunnel: localPort -> 127.0.0.1:18789
  -> POST http://127.0.0.1:localPort/v1/chat/completions
       Authorization: Bearer <openclaw gateway token>
       x-openclaw-agent-id: <selected agent id>
       x-openclaw-session-key: agent:<runtimeAgentId>:main
```

This path can reuse much more of Hermes `hermes.ts` because it already sends
OpenAI-style streaming chat requests from the Electron main process. The main
adapter work becomes:

- set the model to OpenClaw's expected gateway model value
- inject OpenClaw headers
- map desktop conversation ids to OpenClaw-compatible
  `x-openclaw-session-key` values
- normalize OpenClaw stream/tool events if the HTTP stream emits non-OpenAI
  extensions

Raw WebSocket Gateway integration remains a fallback if the HTTP endpoint cannot
carry the events needed by the UI.

OpenClaw session keys must follow the runtime format used by
`buildRuntimeSessionKey`, not an arbitrary desktop-local format:

- main session: `agent:{runtimeAgentId}:main`
- reset epoch: `agent:{runtimeAgentId}:main:e{epoch}`
- explicit label: `agent:{runtimeAgentId}:main:{safeLabel}`
- web conversation scope, if needed later:
  `agent:{runtimeAgentId}:web:{conversationId}` or
  `agent:{runtimeAgentId}:web:{conversationId}:e{epoch}`

For Phase 0, the safest default is one desktop conversation mapped to a stable
`agent:{runtimeAgentId}:main:{safeLabel}` label, where `safeLabel` is generated
from the desktop conversation id and sanitized to `[a-zA-Z0-9_-]`. This avoids
breaking OpenClaw's session registry and keeps conversation recovery possible.

For the first Phase 0 build, avoid a full profile wizard. Use one preset
runtime profile that points to our existing local OpenClaw environment:

```
Profile: Local OpenClaw
Mode: SSH tunnel
Host: work.example.com or 203.0.113.10
Remote gateway: 127.0.0.1:18789
Agent ID: preset from the current local OpenClaw agent
```

The first-run setup should only ask for what cannot be safely embedded in the
build:

1. SSH key path, if SSH tunnel mode is used.
2. Gateway token, only if it is not available through the preset or local test
   configuration.
3. Manual agent id override, only as a debug fallback.

The app then opens the SSH tunnel, probes the gateway, and starts chat. Agent
auto-discovery by reading `~/.openclaw/openclaw.json` and
`~/.openclaw/agents/*` is useful, but it should not block the first working
prototype. Multi-environment profile management can be added after the local
OpenClaw path is proven.

This is likely fast enough for an internal prototype because each user can have
their own profile. The access boundary is the user's SSH credential plus the
OpenClaw gateway token. It is not enterprise governance yet.

For enterprise release, Employee Agent must be reintroduced as the control
plane:

```
Desktop -> Employee Agent: login, available agents, policy, audit, runtime lease
Desktop -> OpenClaw: low-latency execution using the scoped lease/policy
```

So the OpenClaw-direct Hermes fork is useful as a Phase 0 experience prototype,
not as the final governance architecture.

#### Enterprise Control Plane Integration: Runtime Lease

The clean way to reconnect the Phase 0 desktop prototype with Employee Agent
governance is a runtime lease model.

In this model, Desktop keeps the Hermes-like fast execution path, but no longer
decides permissions locally:

```
Control plane:
  Desktop -> Employee Agent
    login, available agents, runtime profiles, policy, audit view

Execution plane:
  Desktop -> SSH tunnel -> OpenClaw
    low-latency streaming and tool execution

Audit plane:
  OpenClaw/tool layer -> Employee Agent
    tool call events, run status, summaries, trace ids
```

Employee Agent issues a short-lived signed lease before Desktop connects to a
runtime. The lease should include:

- user id and tenant/department scope
- adopt id and runtime agent id
- allowed models
- allowed tools/MCP groups
- session scope
- expiry time
- audit trace id
- signature/key id

Desktop then calls OpenClaw with both OpenClaw routing headers and the Employee
Agent lease:

```
x-openclaw-agent-id: <runtimeAgentId>
x-openclaw-session-key: agent:<runtimeAgentId>:main:<safeLabel>
x-employee-runtime-lease: <signed lease>
x-employee-trace-id: <traceId>
```

The first enterprise step can be pragmatic:

1. Desktop logs into Employee Agent.
2. Employee Agent returns the user's allowed desktop runtime profiles.
3. User chooses an agent/profile.
4. Employee Agent issues a short-lived runtime lease.
5. Desktop still talks directly to OpenClaw through SSH/local gateway for
   performance.
6. Tool/run audit events are sent from the server side to Employee Agent.

This preserves the speed of direct OpenClaw execution while keeping Employee
Agent as the authority for identity, authorization, policy, and audit. Desktop
must not become the source of truth for "who can use which agent or tool".

## Current Employee Agent Shape

Current platform strengths:

- React web UI is already mature enough to reuse.
- Backend already owns user identity, agent ownership, sessions, skills, MCP/tool policy, audit, and collaboration.
- OpenClaw integration already supports multiple providers and gateway-based execution.
- Managed browser and other platform tools are being moved toward governed tools instead of unrestricted sandbox network.

Current cloud limitation:

- Some tasks fail because cloud runtime cannot access user-authenticated websites or private documents, such as Feishu pages requiring browser session context.
- Opening more sandbox network permission would improve capability but weakens enterprise governance.

Desktop should solve that limitation with explicit, audited local capabilities rather than broad sandbox escape.

## Recommended Modes

### Mode 1: Remote Private Web Desktop

This is the MVP.

The desktop app loads the existing Employee Agent web UI. Page loads, settings,
session list, REST calls, and the current chat transport can continue to use the
same backend APIs as the browser version.

```
Default:       Renderer ──────────────────────────────→ Backend
Optional:      Renderer → IPC.invoke("chat.send")     → Main → Backend
                                                      ← Main forwards chunks/events via IPC ←
```

The optional main-process transport is a desktop optimization path, not a Phase
1 dependency. It should be enabled only after a benchmark shows that it improves
first-token latency, stability, or private-network routing versus the existing
WebSocket-first transport.

Capabilities:

- Configure server URL, tenant, and environment.
- Persist login/session more reliably than a browser tab.
- Open downloaded files through OS integration.
- Handle deep links.
- Show desktop notifications.
- Provide a local diagnostics panel.

The web renderer does not need to be rewritten for Mode 1. If the desktop
transport adapter is enabled later, it should plug into the existing
`ChatTransport` abstraction instead of duplicating chat parsing and state logic.

### Mode 1.5: Desktop Chat Transport Adapter

This is a focused spike after Mode 1 is usable.

The adapter can proxy streaming chat through Electron main process when that is
useful:

- authenticated cookie/header forwarding through Electron session APIs
- private-network routing or SSH tunnel routing
- Node.js stream handling when browser fetch/WS is blocked by enterprise proxy
- desktop diagnostics around first-token and disconnect behavior

It must preserve the current chat semantics:

- WebSocket-first behavior where supported
- HTTP SSE fallback
- abort propagation
- `__stream_truncated` recovery
- `__stream_end` / `[DONE]` handling
- tool call and workspace file events
- canonical conversation reconciliation after stream completion

Do not replace the existing web transport blindly. Implement a
`DesktopChatTransport` behind runtime detection and feature flag, then compare
browser, desktop-renderer, and desktop-main timings.

### Mode 2: Remote Private Web + Local Bridge

The desktop app still uses the customer's Employee Agent backend, but exposes selected local capabilities through a strict preload bridge.

Candidate bridge capabilities:

- Select local files and stage them for upload.
- Extract readable content from a user-approved URL or browser session.
- Capture screenshot/window content with explicit user action.
- Create SSH tunnels to approved gateway endpoints.
- Run managed local browser extraction.
- Report local health and logs.

This mode addresses the Feishu-style problem without giving every OpenClaw sandbox arbitrary network or shell access.

### Mode 2.5: SSH Private Runtime Gateway

This is the practical path for Hermes-like speed and stability before a fully
managed local runtime exists.

The desktop app connects to a customer-hosted Employee Agent/OpenClaw runtime
through SSH port forwarding:

```text
Electron renderer
  -> preload IPC
    -> Electron main
      -> ssh -N -L localPort:127.0.0.1:remotePort user@host
      -> http://127.0.0.1:localPort
      -> remote Employee Agent/OpenClaw runtime
```

Main process responsibilities:

- allocate a free local port and persist it per runtime/profile
- start, stop, restart, and health-check the SSH tunnel
- verify the remote runtime through `/health`
- cache the remote API token after tunnel start
- proxy streaming chat through Node.js request handling when enabled
- destroy upstream requests on abort
- manage remote logs/config/runtime status through SSH exec where appropriate
- close tunnels on renderer/window/app shutdown

This is different from exposing a public remote URL. From the renderer's point
of view the runtime is a stable local endpoint. That reduces browser/network
edge cases, works better in private enterprise networks, and aligns with Hermes'
remote mode.

For Employee Agent governance, the private runtime must still enforce user
identity, role/tool policy, audit, and agent ownership. The tunnel is a
transport boundary, not an authorization boundary.

### Mode 3: Managed Local Runtime（高安全场景 — 本地运行时）

This is for high-security or air-gapped deployments where even the Employee Agent backend cannot be network-accessible.

Employee Agent 本身已经是私有化部署产品（后端在客户自己服务器上）。Mode 3 针对更极端的场景：需要在用户本机或完全隔离环境中运行 OpenClaw 执行层，不通过网络访问任何外部后端。

```
用户桌面（本机运行 OpenClaw 执行层）
  ↕ IPC
Employee Agent 桌面壳
  ↓（仅同步 policy/audit 时联网）
Employee Agent 后端（企业内网）
```

The desktop app can manage a local OpenClaw or local runner process, but the Employee Agent backend should still own:

- User and role identity.
- Agent authorization.
- Tool and MCP policy.
- Audit synchronization.
- Workspace metadata.

Local runtime should be optional. It should not become the default path for normal enterprise users.

## Technology Choice

Use Electron for the first desktop version.

Reasons:

- It matches Hermes Desktop's proven stack.
- It works on Windows and macOS, which are the important enterprise desktop targets.
- It gives mature access to local files, OS integration, SSH tunnels, local processes, and auto-update.
- It can reuse the existing React UI with minimal redesign.
- The team can prototype quickly.

Mobile shells should live outside this repository unless they become an actively maintained product surface.

## Proposed Repository Layout

Add:

```text
apps/desktop/
  package.json
  electron.vite.config.ts
  src/
    main/
      index.ts          — BrowserWindow, IPC handler registration
      config.ts         — server URL, tenant, env
      security.ts       — navigation allowlist, webContents hardening
      desktop-transport.ts — optional chat proxy, cookie/header forwarding, chunk forwarding
      bridge.ts         — capability dispatch (files, external, etc.)
      tunnels.ts        — SSH tunnel lifecycle + webContents.destroyed cleanup
      ssh-remote.ts     — optional remote config/log/session helpers over SSH exec
      runtime-health.ts — health probe and reconnect orchestration
      diagnostics.ts    — health check, log export
    preload/
      index.ts          — contextBridge: config, diagnostics, optional chat transport callbacks
    renderer/
      optional-local-shell.tsx   — first-run / offline connection page (Phase 2+)
```

Phase 1 loads the remote web app in the renderer. `optional-local-shell.tsx` is only needed for offline loading or a first-run setup page and can be deferred.

## Desktop Bridge API

The renderer should not get raw Node.js access. Expose only a typed preload API.

Example shape:

```ts
window.employeeDesktop = {
  // Config and identity
  getAppInfo(): Promise<AppInfo>;
  getConnectionConfig(): Promise<ConnectionConfig>;
  setConnectionConfig(config: ConnectionConfig): Promise<void>;

  // Optional desktop chat transport. Web builds keep using the current transport.
  sendMessage(payload: SendMessagePayload): Promise<void>;
  abortMessage(sessionId: string): Promise<void>;
  onChatChunk(cb: (chunk: ChatChunk) => void): () => void;     // returns unsubscribe
  onChatDone(cb: (result: ChatDone) => void): () => void;
  onChatError(cb: (err: ChatError) => void): () => void;

  // Local capabilities (Mode 2+)
  selectFiles(options: SelectFilesOptions): Promise<SelectedFile[]>;
  openExternal(url: string): Promise<void>;
  createSshTunnel(config: TunnelConfig): Promise<TunnelHandle>;
  listActiveTunnels(): Promise<TunnelHandle[]>;
  destroyTunnel(handle: TunnelHandle): Promise<void>;
  testSshRuntime(config: TunnelConfig): Promise<RuntimeHealth>;
  getRuntimeHealth(runtimeId?: string): Promise<RuntimeHealth>;
  getHealth(): Promise<DesktopHealth>;
  getLocalCapabilities(): Promise<LocalCapability[]>;
};
```

The `on*` callbacks follow the Hermes pattern: each returns an unsubscribe function that calls `ipcRenderer.removeListener(...)`. The renderer must call the unsubscribe on component unmount to prevent listener leaks across hot reloads.

For desktop chat transport, main process must forward the same authentication
state as the renderer. In practice this means reading cookies from the Electron
session, preserving CSRF/session headers if the backend requires them, and
ensuring aborts destroy the upstream request. Without this, the proxy can look
correct but fail on authenticated endpoints.

The backend can then decide which capabilities are enabled for a tenant, user, or role.

Tunnel lifecycle must be owned by the Electron main process. Any tunnel created
for a renderer should be closed explicitly through `destroyTunnel`, and the main
process should also clean up renderer-owned tunnels on `webContents.destroyed`.
This prevents leaked SSH tunnels when the UI crashes, reloads, or the user closes
the window.

## Security Model

Minimum Electron security baseline:

- `contextIsolation: true`
- `nodeIntegration: false`
- sandboxed renderer where feasible
- strict preload API surface
- remote URL allowlist
- block unexpected navigation
- block unexpected window creation
- never expose arbitrary shell execution to the renderer
- clean up local resources such as SSH tunnels when the renderer is destroyed

Capability policy should be explicit:

```text
stream.desktop_transport      — optional; main process may proxy chat transport after benchmark
file.read.selected
file.upload.selected
browser.extract.approved_url
browser.screenshot.user_initiated
ssh.tunnel.approved_host
ssh.runtime.health
ssh.runtime.logs
ssh.runtime.config.read
local.openclaw.manage
```

Audit should record:

- User ID
- Agent ID
- Session ID
- Desktop device ID
- Capability name
- Target host or file metadata
- Start/end time
- Success/failure
- Result size, not full sensitive content by default

For banking deployments, this gives a clearer story than simply allowing sandbox scripts to access the network.

## Enterprise Deployment

Desktop packaging should eventually support:

- Windows installer
- macOS DMG/PKG
- Code signing
- Auto-update
- Enterprise proxy configuration
- Offline installer option
- MDM/config-file controlled server URL
- Tenant-level feature flags

First internal builds can skip code signing, but customer-facing builds cannot.

## What Not To Do

Do not fork the current web UI into a separate desktop-only product.

Do not move user, role, agent, skill, and MCP authorization into the desktop app.

Do not expose unrestricted local shell or network access as a default capability.

Do not make local runtime a prerequisite for normal users.

Do not solve every tool need with a new desktop runner. Prefer governed platform tools and MCP/tool policy first.

## Phased Roadmap

### Phase 0: Design and Prototype

Deliverables:

- This strategy document.
- Hermes Desktop fork evaluation and minimal rebrand prototype.
- Remove or hide non-essential Hermes menus for the prototype:
  Skills, Memory, Providers, Gateway, and local runner setup pages.
- Add one preset local OpenClaw runtime profile instead of a full profile
  manager:
  host, SSH user, remote gateway port, optional gateway token, and preset
  runtime agent id.
- First-run input is limited to SSH key path and optional debug overrides.
- Reuse Hermes SSH tunnel mode to map remote `127.0.0.1:18789` to a local
  port.
- Reuse Hermes main-process `/v1/chat/completions` transport where possible,
  injecting OpenClaw headers:
  `Authorization`, `x-openclaw-agent-id`, and
  `x-openclaw-session-key`.
- Use OpenClaw-compatible session keys:
  `agent:{runtimeAgentId}:main`, `agent:{runtimeAgentId}:main:e{epoch}`, or
  `agent:{runtimeAgentId}:main:{safeLabel}`.
- Agent auto-discovery is optional in Phase 0; a preset agent id plus manual
  debug override is enough for the first build.
- Validate one end-to-end chat against local OpenClaw and one SSH-tunneled
  remote OpenClaw environment.
- Keep Employee Agent backend untouched in Phase 0.

Success criteria:

- A user can select an SSH key, connect to the preset local OpenClaw profile,
  send a message, receive streaming output, and resume a conversation without
  session leakage.
- The prototype demonstrates desktop stability benefits: SSH tunnel health
  check, reconnect, and local session/profile persistence.
- Any missing enterprise governance is explicitly documented as out of scope
  for Phase 0.

### Phase 1: Remote Desktop Shell

Target: 2-3 weeks.

Deliverables:

- macOS development build.
- Windows development build if signing and installer preparation are ready;
  otherwise move the polished Windows installer to early Phase 2.
- Configurable server URL.
- Login/session persistence.
- External link handling.
- File download/open handling.
- Basic health diagnostics.
- **睡眠/唤醒重连**：监听 `powerMonitor.on('resume')` 事件，唤醒后主动检测 WebSocket/SSE 连接状态并重连。这是纯桌面问题——浏览器用户会刷页，桌面用户不会，合盖两小时后打开直接发消息会静默失败。参考：Hermes `index.ts` 的 `powerMonitor` 处理。
- **发送前连接检查（桌面语义）**：用户发消息前检查后端连通性，断线时给出明确提示而不是等 30 秒超时。与 web 版"发了才知道失败"不同，桌面用户的心智模型是"app 应该自己搞定连接"。失败软降级（提示重连，不硬拦截），避免慢链路误伤。

Success criteria:

- Existing chat works with current web transport.
- Web deployment is unchanged; no code fork.
- Users can use the desktop app as a stable replacement for browser access.
- 合盖再开后能在 5 秒内自动恢复连接，无需手动刷新。

### Phase 1.5: Desktop Chat Transport Spike

Target: 1 week after Phase 1.

Deliverables:

- `DesktopChatTransport` prototype behind feature flag.
- Main-process stream proxy that forwards cookies/session headers correctly.
- SSH localhost gateway prototype against one existing private runtime, using
  `ssh -N -L localPort:127.0.0.1:remotePort`.
- `/health` probe, reconnect, and tunnel cleanup.
- Abort propagation and listener cleanup.
- Timing comparison against current browser WebSocket and HTTP fallback paths.
- Decision record: keep disabled, enable for specific enterprise networks, or
  make it the desktop default.

Success criteria:

- No loss of current stream semantics.
- Measurable improvement in first-token latency, disconnect recovery, or
  enterprise proxy compatibility.
- SSH localhost mode can survive network interruption, sleep/resume, and tunnel
  restart without requiring the user to manually reconfigure the app.

### Phase 2: Local Capability Bridge + Session Cache

Target: 2-4 weeks after Phase 1.

Deliverables:

- Local file picker and upload staging.
- Managed browser extraction capability.
- SSH tunnel support for approved gateway targets.
- Local diagnostics export.
- Capability audit events sent to Employee Agent backend.
- **Session cache（内存 + 本地持久化）**：session 列表首屏从内存读，后台增量同步云端变更。参考 Hermes `session-cache.ts` 的双层架构（内存数组 + 本地 JSON 文件 + 按 `lastSync` 增量拉取）。不做 session cache，切换会话的速度和浏览器版没有区别，Hermes 的"秒开"体验来源于此。
- SSH private runtime connector hardening: profile-level local port allocation,
  remote API key discovery, remote log viewing, and remote gateway restart for
  trusted admin users.

Success criteria:

- Feishu/private-web style extraction becomes possible when the user has local access.
- Capabilities are visible, controllable, and auditable.
- Session 列表首次加载时间 < 200ms（来自本地缓存，不等网络）。

### Phase 3: Managed Local Runtime

Target: customer-driven.

Deliverables:

- Optional local OpenClaw/runtime installer.
- Start/stop/status controls.
- Runtime version check.
- Runtime log viewer.
- Central policy sync.
- Offline audit buffering.

Success criteria:

- Enterprise intranet users can run tasks against local/private resources.
- Central governance remains intact.

### Phase 4: Local-First Enterprise Workflows

Possible future work:

- Background tasks.
- Local knowledge indexing.
- Offline drafting and later sync.
- Local-only confidential workspace mode.

## Open Questions

- Which customers require local runtime versus remote shell?
- Do we have macOS and Windows code signing certificates?
- Should Linux be supported early or treated as internal only?
- How should offline audit buffering be retained and uploaded?
- Which local browser actions are allowed without additional confirmation?
- Should desktop device registration be mandatory for enterprise tenants?
- Which current Web UI flows assume a standard browser environment and need
  adjustment before running inside Electron?
- Does desktop main-process transport actually outperform the current
  WebSocket-first web transport in our local, Shanghai, and Singapore
  environments?
- Which initial private runtime should be used to validate SSH localhost mode:
  local server, Singapore experiment, or Shanghai private deployment?
- Which remote admin operations are safe to expose over SSH exec in enterprise
  mode: logs only, restart, config read, config write, plugin install?

## Recommendation

Build `apps/desktop` as an Electron remote shell first, but make SSH localhost
gateway validation an early priority. If the goal is Hermes-like stability and
speed, the important architecture is not "Electron shell"; it is "desktop main
process owns a local endpoint that represents the runtime."

**Employee Agent 是私有化部署产品**，后端在客户自己的服务器上，不是我们托管的 SaaS。桌面版的价值主张要从这个前提出发：

**内网用户**：后端就在局域网里，延迟本来就低。桌面版的价值是稳定性（睡眠重连、session 持久化）和 OS 集成（本地文件、通知），不是速度。

**远程/外网用户**：这是桌面版最有价值的场景。用户不在公司内网时，SSH 隧道提供稳定的穿透访问，比让用户配 VPN 体验更好，也比浏览器 WebSocket 在弱网/企业代理下更稳定。Phase 1 的三个核心交付物（睡眠重连、发送前检查、session 本地缓存）在这个场景下效果最明显。Phase 1.5 应该优先验证 SSH localhost gateway，而不是只做普通公网 remote URL。

Transport optimization (Mode 1.5) is still worth exploring but should be judged
by measurements, not assumed. The current web client already has WebSocket-first
streaming and HTTP recovery that a naive proxy would need to replicate in full.

This approach keeps governance in the customer's Employee Agent backend and
creates a clean path for banking and enterprise intranet deployments where local
access is necessary.
