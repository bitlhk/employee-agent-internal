/**
 * openclaw-ws.ts — 岗位智能体平台前端 WebSocket 客户端
 *
 * 连接 /api/claw/ws?adoptId=xxx，岗位智能体平台后端代理到 OpenClaw Gateway。
 * 支持自动降级到 HTTP SSE。
 */

export type WSState = "idle" | "connecting" | "connected" | "disconnected";

export interface ChatDelta {
  content?: string;
  toolCall?: { id: string; name: string; status: "start" | "end"; preview?: string };
  status?: string;
  done?: boolean;
  error?: string;
}

type MessageHandler = (delta: ChatDelta) => void;
type StateHandler = (state: WSState) => void;

export class OpenClawWSClient {
  private ws: WebSocket | null = null;
  private _state: WSState = "idle";
  private adoptId: string;
  private apiBase: string;
  private channel: string;
  private conversationId: string;
  private onMessage: MessageHandler | null = null;
  private onStateChange: StateHandler | null = null;
  // 跨重连保持的 raw 消息处理器：每次 ws.onmessage 收到原始 JSON 都会调用
  // 上层用 setRawHandler 注册，断线重连后自动绑定到新的 WebSocket
  private rawHandler: ((data: any) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private backoffMs = 1000;
  private closed = false;
  private agentId: string | null = null;

  constructor(adoptId: string, apiBase = "", options: { channel?: string; conversationId?: string } = {}) {
    this.adoptId = adoptId;
    this.apiBase = apiBase;
    this.channel = options.channel || "";
    this.conversationId = options.conversationId || "";
  }

  get state(): WSState {
    return this._state;
  }

  private setState(s: WSState) {
    this._state = s;
    this.onStateChange?.(s);
  }

  setHandlers(onMessage: MessageHandler, onStateChange?: StateHandler) {
    this.onMessage = onMessage;
    this.onStateChange = onStateChange || null;
  }

  // 设置/清除原始消息处理器（跨重连保持）
  setRawHandler(handler: ((data: any) => void) | null) {
    this.rawHandler = handler;
  }

  async connect(): Promise<boolean> {
    if (this._state === "connected") return true;
    if (this._state === "connecting" && this.connectPromise) return this.connectPromise;
    this.closed = false;

    this.connectPromise = new Promise((resolve) => {
      const finish = (ok: boolean) => {
        this.connectPromise = null;
        resolve(ok);
      };
      this.setState("connecting");

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = this.apiBase ? new URL(this.apiBase).host : window.location.host;
      const params = new URLSearchParams({ adoptId: this.adoptId });
      if (this.channel) params.set("channel", this.channel);
      if (this.conversationId) params.set("conversationId", this.conversationId);
      const url = `${protocol}//${host}/api/claw/ws?${params.toString()}`;

      try {
        this.ws = new WebSocket(url);
      } catch {
        this.setState("disconnected");
        resolve(false);
        return;
      }

      const timeout = setTimeout(() => {
        if (this._state === "connecting") {
          this.ws?.close();
          this.setState("disconnected");
          finish(false);
        }
      }, 15000);

      this.ws.onopen = () => {
        // 等 gateway 认证完成（后端会发 { type: "connected" }）
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          // 先把 raw 数据回调给上层（流式 stream 事件需要这个，跨重连保持）
          if (this.rawHandler) {
            try { this.rawHandler(msg); } catch (e) { console.warn("[WS] rawHandler error:", e); }
          }

          // 后端代理认证完成通知
          if (msg.type === "connected") {
            clearTimeout(timeout);
            this.agentId = msg.agentId;
            this.setState("connected");
            this.backoffMs = 1000;
            finish(true);
            return;
          }

          // 错误
          if (msg.type === "error" || (msg.type === "res" && msg.ok === false)) {
            this.onMessage?.({ error: msg.message || msg.error?.message || "Gateway error" });
            return;
          }

          // Gateway RPC 响应
          if (msg.type === "res" && msg.ok === true) {
            // sessions.send 成功，等后续 stream 事件
            return;
          }

          // Gateway 事件（流式内容）
          if (msg.type === "event") {
            this.handleGatewayEvent(msg);
          }
        } catch {
          // 非 JSON 忽略
        }
      };

      this.ws.onclose = () => {
        clearTimeout(timeout);
        const wasConnected = this._state === "connected";
        const wasConnecting = this._state === "connecting";
        this.setState("disconnected");
        this.ws = null;

        if (wasConnecting) {
          finish(false);
        }

        if (!this.closed && wasConnected) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        // onclose 会处理
      };
    });
    return this.connectPromise;
  }

  private handleGatewayEvent(msg: any) {
    const event = msg.event || "";
    const payload = msg.payload || {};

    // 流式文本
    if (event === "sessions.stream.delta" || event.includes("delta")) {
      const content = payload.delta?.content || payload.content || "";
      if (content) {
        this.onMessage?.({ content });
      }
      return;
    }

    // 工具调用
    if (event === "sessions.tool.start" || event.includes("tool") && event.includes("start")) {
      this.onMessage?.({ toolCall: { id: payload.id || "", name: payload.name || "tool", status: "start", preview: payload.preview } });
      return;
    }
    if (event === "sessions.tool.end" || event.includes("tool") && event.includes("end")) {
      this.onMessage?.({ toolCall: { id: payload.id || "", name: payload.name || "tool", status: "end" } });
      return;
    }

    // 状态
    if (event === "sessions.status" || event.includes("status")) {
      this.onMessage?.({ status: payload.text || payload.status || "" });
      return;
    }

    // 完成
    if (event === "sessions.stream.end" || event === "sessions.done" || event.includes("complete")) {
      this.onMessage?.({ done: true });
      return;
    }
  }

  sendChat(message: string, sessionKey?: string, meta?: { clientRunId?: string; userMessageId?: string; channel?: string; conversationId?: string; runtimeMode?: "fast" | "plan" }) {
    if (!this.ws || this._state !== "connected") return false;
    this.ws.send(JSON.stringify({
      type: "chat",
      message,
      sessionKey,
      clientRunId: meta?.clientRunId,
      userMessageId: meta?.userMessageId,
      channel: meta?.channel,
      conversationId: meta?.conversationId,
      runtimeMode: meta?.runtimeMode,
    }));
    return true;
  }

  disconnect() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
    this.setState("disconnected");
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 1.5, 15000);
  }
}
