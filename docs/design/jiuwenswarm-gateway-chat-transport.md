# JiuwenSwarm Gateway Chat Transport Design

## Background

EA currently connects JiuwenSwarm chat through AgentServer WebSocket directly.
This was enough for basic streaming chat, but it bypasses JiuwenSwarm's native
channel/gateway state machine.

The direct path is now causing correctness issues around interactive runtime
state:

- Permission approval can render in EA, but "allow once" may not resume the
  original tool call.
- Pending approval can leak into a later user message.
- Frontend processing/loading state can diverge from the actual Jiuwen runtime.
- Follow-up channel features such as scheduled task callbacks, supplement input,
  `ask_user`, and skill/tool approvals need channel semantics, not only raw
  AgentServer requests.

JiuwenSwarm native Web/TUI uses the gateway channel. For interrupt resumes, it
sends `chat.send` with an empty query, the pending `request_id`, `answers`, and
`source`. The gateway recognizes this as an interrupt-resume request and does
not cancel the existing stream.

## Goal

Move EA's JiuwenSwarm main chat integration from direct AgentServer WebSocket to
JiuwenSwarm gateway channel semantics, while preserving a fallback to the
current direct AgentServer bridge.

The first migration should only cover the minimum path needed to fix approval
and stream lifecycle correctness:

- Normal main-chat message streaming.
- Permission / confirm / ask-user answer submission.
- Cancel and supplement operations if needed by the same state machine.
- SSE event shape compatible with existing EA frontend handling.

## Non-Goals

- Do not rewrite all history loading in the first step.
- Do not migrate collaboration, scheduled task callbacks, or skill-market flows
  in the first step.
- Do not delete the existing AgentServer direct bridge until gateway transport
  has run stably.
- Do not patch JiuwenSwarm runtime first unless gateway transport exposes a
  missing upstream capability.

## Existing Paths

### Current Jiuwen Path

```
EA frontend
  -> /api/claw/chat-stream
  -> EA server jiuwenclaw-bridge
  -> Jiuwen AgentServer WS
```

Permission answer currently does:

```
EA frontend
  -> /api/claw/jiuwen/permission-answer
  -> EA server jiuwenclaw-bridge
  -> new Jiuwen AgentServer WS request
```

This opens a new request after the original stream has already been closed, so
AgentServer can convert answers into `InteractiveInput` but has no reliable
pending runtime to resume.

### Native Jiuwen Path

```
Jiuwen Web/TUI frontend
  -> Jiuwen gateway channel request(chat.send / chat.interrupt / chat.user_answer)
  -> MessageHandler queue
  -> AgentServer stream task
```

For permission answer:

```json
{
  "method": "chat.send",
  "params": {
    "session_id": "...",
    "query": "",
    "request_id": "call_xxx",
    "answers": [{"selected_options": ["本次允许"]}],
    "source": "permission_interrupt"
  }
}
```

Gateway detects `request_id + answers + source` and treats it as
interrupt-resume instead of a new user message.

## Proposed Architecture

Introduce a new server-side transport abstraction:

```ts
type JiuwenChatTransport = "agentserver" | "gateway";
```

Environment switch:

```bash
JIUWENCLAW_CHAT_TRANSPORT=agentserver # default initially
JIUWENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:19000/ws
```

Expected code split:

- Keep `jiuwenclaw-bridge.ts` as the public bridge used by EA routes.
- Add a gateway client module, for example:
  `server/_core/jiuwenswarm-gateway-client.ts`
- Let `forwardToJiuwenClaw()` dispatch to either:
  - current AgentServer implementation, or
  - gateway implementation.
- Let `answerJiuwenPermission()` dispatch through the same transport.

## Gateway Client Responsibilities

The gateway client should manage a per-request WebSocket connection at first.
Persistent shared connections can be considered later if needed.

Required behavior:

- Connect to Jiuwen gateway WebSocket.
- Send JSON-RPC-style requests used by native Jiuwen web channel.
- Convert gateway pushed events into EA's current SSE chunk shape.
- Preserve EA's existing frontend contract as much as possible:
  - `choices[].delta.content`
  - `tool_call`
  - `tool_result`
  - `jiuwen_permission_required`
  - `__stream_end`
- Do not close the underlying gateway stream when a permission card is emitted,
  unless native gateway marks the stream complete.

## Event Mapping

Initial mapping should be conservative:

| Jiuwen event | EA SSE output |
| --- | --- |
| `chat.delta` | `choices[0].delta.content` |
| `chat.tool_call` | existing EA tool-call chunk |
| `chat.tool_result` | existing EA tool-result chunk |
| `chat.ask_user_question` | `jiuwen_permission_required` |
| `chat.processing_status` | internal processing/logging, optional frontend state |
| stream end / complete | `__stream_end` + `[DONE]` |

If gateway emits events with the same payload shape already handled by
`jiuwenclaw-bridge.ts`, reuse the existing normalization helpers rather than
creating a second parser.

## Permission Resume

For `permission_interrupt`, `confirm_interrupt`, and `ask_user_interrupt`, answer
submission must call gateway `chat.send`, not a fresh direct AgentServer request.

Payload:

```json
{
  "session_id": "...",
  "query": "",
  "request_id": "call_xxx",
  "answers": [{"selected_options": ["本次允许"]}],
  "source": "permission_interrupt"
}
```

This mirrors Jiuwen native Web/TUI and avoids local checkpoint deletion hacks in
the normal path.

## Rollback Strategy

The old direct bridge remains available behind:

```bash
JIUWENCLAW_CHAT_TRANSPORT=agentserver
```

Gateway rollout can be local-only first, then Shanghai-only, then default.

If gateway behavior is unstable, revert the env var without reverting code.

## Performance Expectations

Gateway adds one local in-process/network hop, but should not materially slow
token streaming because Jiuwen native Web/TUI already streams through this path.

Expected performance impact:

- First token may be slightly slower by a small local dispatch overhead.
- End-to-end perceived latency should improve in approval-heavy or interrupt
  scenarios because EA no longer needs checkpoint cleanup and retry workarounds.
- Stability should improve more than raw latency changes.

Instrument before/after:

- client request start
- EA route enter
- gateway request sent
- first gateway chunk
- first SSE chunk
- stream complete

## Smoke Tests

Run locally before any Shanghai sync:

1. Normal chat:
   - "北京今天天气如何？"
   - Expect normal streaming answer, no stale approval card.
2. Permission allow:
   - "请用 bash 执行 pwd，并列出当前目录下的文件"
   - Click "本次允许".
   - Expect actual `pwd && ls` result after approval.
3. Permission reject:
   - Ask for a bash action.
   - Click "拒绝".
   - Expect no command execution and a clear rejected result.
4. New message while permission pending:
   - Trigger permission card.
   - Send a new unrelated message without approving.
   - Expect old approval not to contaminate the new response.
5. Loading state:
   - Open history/session after a response.
   - Expect no permanent "switching/loading" state.

## Migration Steps

1. Add transport switch and gateway client skeleton.
2. Implement normal `chat.send` streaming via gateway.
3. Implement permission answer through gateway.
4. Reuse existing EA SSE normalization for text/tool/permission events.
5. Run local smoke with `JIUWENCLAW_CHAT_TRANSPORT=gateway`.
6. Keep default as `agentserver` until smoke passes.
7. After local validation, switch the target EA environment only.
