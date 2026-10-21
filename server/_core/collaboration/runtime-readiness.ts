import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
type ProbeFrame = {
  request_id?: string;
  response_id?: string;
  is_final?: boolean;
  status?: string;
  body?: {
    result?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  };
  payload?: Record<string, unknown>;
};

// Probe the running process, not a marker on disk: an installed patch has no
// effect until that service is restarted. No model/user data is sent here.
export async function collaborationRuntimeCommand(
  params: Record<string, unknown>,
  url = process.env.JIUWENCLAW_AGENTSERVER_WS_URL || "ws://127.0.0.1:19001"
): Promise<Record<string, unknown>> {
  const requestId = randomUUID();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, {
      headers: {
        Origin: process.env.JIUWENCLAW_WS_ORIGIN || url.replace(/^ws/, "http"),
      },
    });
    const finish = (error?: Error, payload: Record<string, unknown> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve(payload);
    };
    const timer = setTimeout(() => {
      ws.terminate();
      finish(new Error("受限协作运行服务未能确认兼容能力，请检查服务后继续"));
    }, 5000);
    timer.unref();
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          protocol_version: "1.0",
          request_id: requestId,
          timestamp: new Date().toISOString(),
          identity_origin: "system",
          channel: "ea-collaboration-probe",
          method: "command.status",
          is_stream: false,
          params,
        })
      )
    );
    ws.on("message", raw => {
      let frame: ProbeFrame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (String(frame.request_id || frame.response_id || "") !== requestId)
        return;
      const payload =
        frame.body?.result ?? frame.body?.payload ?? frame.payload;
      if (
        payload &&
        (payload.persisted === true ||
          payload.ea_collaboration_scope_version === 1)
      )
        finish(undefined, payload);
      else if (
        frame.is_final ||
        ["succeeded", "failed"].includes(String(frame.status))
      )
        finish(
          new Error(
            "运行服务未确认写入或兼容能力，请检查运行服务补丁与配置并重启运行服务"
          )
        );
    });
    ws.on("error", () =>
      finish(new Error("受限协作运行服务连接失败，请检查服务后继续"))
    );
    ws.on("close", () => {
      if (!settled) finish(new Error("受限协作兼容检查未完成"));
    });
  });
}

export async function assertCollaborationRuntimeReady(url?: string) {
  const result = await collaborationRuntimeCommand(
    { action: "ea-collaboration" },
    url
  );
  if (
    result.ea_collaboration_scope_version !== 1 ||
    result.ea_conversation_context_version !== 1
  )
    throw new Error("运行服务缺少协作对话能力，请更新补丁并重启运行服务");
}
