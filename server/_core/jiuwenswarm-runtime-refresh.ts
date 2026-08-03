import { WebSocket, type RawData } from "ws";

const DEFAULT_AGENTSERVER_WS_URL = "ws://127.0.0.1:19001";
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

function parseFrame(raw: RawData): Record<string, any> | null {
  try {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function wsOrigin(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl);
    return `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
  } catch {
    return "http://127.0.0.1";
  }
}

export function buildJiuwenCapabilityRefreshRequest(adoptId: string, requestId: string) {
  return {
    protocol_version: "1.0",
    request_id: requestId,
    timestamp: new Date().toISOString(),
    identity_origin: "system",
    channel: adoptId,
    method: "agent.reload_config",
    is_stream: false,
    params: {
      target_channel_id: adoptId,
      reload_scopes: ["agent_runtime"],
    },
  };
}

export async function refreshJiuwenRuntimeCapabilities(adoptIdRaw: string): Promise<void> {
  const adoptId = String(adoptIdRaw || "").trim();
  if (!adoptId) throw new Error("adoptId is required for runtime capability refresh");

  const wsUrl = String(
    process.env.JIUWENCLAW_AGENTSERVER_WS_URL || DEFAULT_AGENTSERVER_WS_URL,
  ).trim();
  const requestId = `ea-capability-refresh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const request = buildJiuwenCapabilityRefreshRequest(adoptId, requestId);
  const timeoutMs = Math.max(
    3_000,
    Number(process.env.JIUWENCLAW_CAPABILITY_REFRESH_TIMEOUT_MS || DEFAULT_REFRESH_TIMEOUT_MS)
      || DEFAULT_REFRESH_TIMEOUT_MS,
  );

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let sent = false;
    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: process.env.JIUWENCLAW_WS_ORIGIN || wsOrigin(wsUrl),
      },
    });
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(1000, error ? "capability refresh failed" : "capability refresh complete"); } catch {}
      if (error) reject(error);
      else resolve();
    };
    const send = () => {
      if (sent || ws.readyState !== WebSocket.OPEN) return;
      sent = true;
      ws.send(JSON.stringify(request));
    };
    const timeout = setTimeout(() => {
      settle(new Error(`JiuwenSwarm capability refresh timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    ws.on("open", send);
    ws.on("message", (raw) => {
      const frame = parseFrame(raw);
      if (!frame) return;
      if (frame.event === "connection.ack") {
        send();
        return;
      }
      const responseId = String(frame.request_id || frame.response_id || "");
      if (responseId !== requestId) return;
      if (frame.status === "failed" || frame.response_kind === "e2a.error") {
        const message = String(
          frame?.body?.error?.message
          || frame?.body?.error
          || frame?.body?.result?.error
          || "JiuwenSwarm capability refresh failed",
        );
        settle(new Error(message));
        return;
      }
      if (frame.is_final === true || frame.status === "succeeded" || frame.response_kind === "e2a.complete") {
        settle();
      }
    });
    ws.on("error", (error) => settle(error instanceof Error ? error : new Error(String(error))));
    ws.on("close", () => {
      if (!settled) settle(new Error("JiuwenSwarm capability refresh connection closed early"));
    });
  });
}
