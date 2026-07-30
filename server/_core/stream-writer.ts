/**
 * stream-writer.ts — 传输层抽象
 * 
 * StreamWriter 统一 SSE / WebSocket / 未来渠道的流式输出接口。
 * 传输层创建对应 Writer，
 * 路由层（intent-agent）和执行层（intent-executor）只依赖此接口。
 */

export interface StreamWriter {
  writeText(text: string): void;
  writeRaw(data: object): void;
  writeEnd(): void;
  writeError(msg: string): void;
  readonly ended: boolean;
}

/** HTTP SSE 流式写入 */
export class SseStreamWriter implements StreamWriter {
  private _ended = false;
  constructor(private res: { writableEnded: boolean; write(chunk: string): boolean; end(): void; setHeader(k: string, v: string): void; flushHeaders(): void }) {}

  get ended() { return this._ended || this.res.writableEnded; }

  init() {
    this.res.setHeader("Content-Type", "text/event-stream");
    this.res.setHeader("Cache-Control", "no-cache");
    this.res.setHeader("Connection", "keep-alive");
    this.res.setHeader("X-Accel-Buffering", "no");
    this.res.flushHeaders();
  }

  writeText(text: string) {
    if (!this.ended) {
      this.res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })}\n\n`);
    }
  }

  writeRaw(data: object) {
    if (!this.ended) {
      this.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  writeEnd() {
    if (!this.ended) {
      this._ended = true;
      this.res.write(`data: ${JSON.stringify({ __stream_end: true })}\n\n`);
      this.res.write("data: [DONE]\n\n");
      this.res.end();
    }
  }

  writeError(msg: string) {
    this.writeText(`\n\n❌ ${msg}\n`);
    this.writeEnd();
  }
}

/** WebSocket 流式写入 */
export class WsStreamWriter implements StreamWriter {
  private _ended = false;
  constructor(private ws: { readyState: number; send(data: string): void }, private WS_OPEN = 1) {}

  get ended() { return this._ended || this.ws.readyState !== this.WS_OPEN; }

  writeText(text: string) {
    if (!this.ended) {
      this.ws.send(JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] }));
    }
  }

  writeRaw(data: object) {
    if (!this.ended) {
      this.ws.send(JSON.stringify(data));
    }
  }

  writeEnd() {
    if (!this.ended) {
      this._ended = true;
      this.ws.send(JSON.stringify({ __stream_end: true }));
      this.ws.send(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    }
  }

  writeError(msg: string) {
    this.writeText(`\n\n❌ ${msg}\n`);
    this.writeEnd();
  }
}
