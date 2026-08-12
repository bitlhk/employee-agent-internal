import express from "express";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket as WS } from "ws";
import { resolveRequesterUserId } from "./helpers";

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

type XfyunWord = { cw?: Array<{ w?: string }> };
type XfyunIatResult = {
  sn?: number;
  pgs?: string;
  rg?: [number, number];
  ws?: XfyunWord[];
};

export function applyXfyunIatResult(
  segments: Map<number, string>,
  result: XfyunIatResult,
): void {
  const sn = Number.isInteger(result.sn) ? Number(result.sn) : segments.size;
  if (result.pgs === "rpl" && Array.isArray(result.rg)) {
    const [start, end] = result.rg.map(Number);
    for (let index = start; index <= end; index += 1) segments.delete(index);
  }
  const text = (result.ws || [])
    .map(word => String(word.cw?.[0]?.w || ""))
    .join("");
  segments.set(sn, text);
}

export function joinXfyunIatSegments(segments: Map<number, string>): string {
  return [...segments.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("")
    .trim();
}

async function readRequestBody(req: express.Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_AUDIO_BYTES) throw new Error("EA_AUDIO_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function transcodeToPcm(audioBuffer: Buffer): Promise<Buffer> {
  const token = randomUUID();
  const inputPath = path.join(os.tmpdir(), `ea-voice-${token}.input`);
  const outputPath = path.join(os.tmpdir(), `ea-voice-${token}.pcm`);
  await fs.writeFile(inputPath, audioBuffer, { mode: 0o600 });
  try {
    await new Promise<void>((resolve, reject) => {
      const process = spawn("ffmpeg", [
        "-nostdin", "-loglevel", "error", "-y", "-i", inputPath,
        "-ar", "16000", "-ac", "1", "-f", "s16le", outputPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      process.stderr.on("data", chunk => {
        if (stderr.length < 2048) stderr += String(chunk).slice(0, 2048 - stderr.length);
      });
      process.on("error", reject);
      process.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`EA_AUDIO_TRANSCODE_FAILED:${stderr.trim()}`));
      });
    });
    return await fs.readFile(outputPath);
  } finally {
    await Promise.all([
      fs.rm(inputPath, { force: true }),
      fs.rm(outputPath, { force: true }),
    ]);
  }
}

async function transcribeWithXfyun(input: {
  pcmBuffer: Buffer;
  appId: string;
  apiSecret: string;
  apiKey: string;
}): Promise<string> {
  const host = "iat-api.xfyun.cn";
  const wsPath = "/v2/iat";
  const date = new Date().toUTCString();
  const signOrigin = `host: ${host}\ndate: ${date}\nGET ${wsPath} HTTP/1.1`;
  const signature = createHmac("sha256", input.apiSecret)
    .update(signOrigin)
    .digest("base64");
  const authOrigin = `api_key="${input.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authOrigin).toString("base64");
  const wsUrl = `wss://${host}${wsPath}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;
  const segments = new Map<number, string>();

  await new Promise<void>((resolve, reject) => {
    const ws = new WS(wsUrl);
    let settled = false;
    let offset = 0;
    let frameIndex = 0;
    let sentFinalFrame = false;
    let sendTimer: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => finish(new Error("讯飞语音识别超时")), 30000);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (sendTimer) clearInterval(sendTimer);
      try {
        ws.close();
      } catch {}
      if (error) reject(error);
      else resolve();
    };

    const business = {
      language: "zh_cn",
      domain: "iat",
      accent: "mandarin",
      vad_eos: 3000,
      dwa: "wpgs",
    };

    ws.on("open", () => {
      sendTimer = setInterval(() => {
        if (offset >= input.pcmBuffer.length) {
          if (!sentFinalFrame) {
            sentFinalFrame = true;
            ws.send(JSON.stringify({
              data: {
                status: 2,
                format: "audio/L16;rate=16000",
                encoding: "raw",
                audio: "",
              },
            }));
          }
          if (sendTimer) clearInterval(sendTimer);
          return;
        }
        const end = Math.min(offset + 1280, input.pcmBuffer.length);
        const firstFrame = frameIndex === 0;
        ws.send(JSON.stringify({
          common: firstFrame ? { app_id: input.appId } : undefined,
          business: firstFrame ? business : undefined,
          data: {
            status: firstFrame ? 0 : 1,
            format: "audio/L16;rate=16000",
            encoding: "raw",
            audio: input.pcmBuffer.subarray(offset, end).toString("base64"),
          },
        }));
        offset = end;
        frameIndex += 1;
      }, 40);
    });

    ws.on("message", raw => {
      try {
        const message = JSON.parse(String(raw));
        if (message.code !== 0) {
          finish(new Error(message.message || `讯飞识别错误 ${message.code}`));
          return;
        }
        if (message.data?.result) applyXfyunIatResult(segments, message.data.result);
        if (message.data?.status === 2) finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("讯飞响应解析失败"));
      }
    });
    ws.on("error", error => finish(error));
    ws.on("close", () => {
      if (!settled) finish(new Error("讯飞语音识别连接提前关闭"));
    });
  });

  return joinXfyunIatSegments(segments);
}

async function requireAuthenticatedUser(req: express.Request, res: express.Response): Promise<boolean> {
  const userId = await resolveRequesterUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}

export function registerVoiceRoutes(app: express.Express) {
  app.post("/api/claw/voice/transcribe", async (req, res) => {
    try {
      if (!(await requireAuthenticatedUser(req, res))) return;
      const audioBuffer = await readRequestBody(req);
      if (audioBuffer.length === 0) {
        res.status(400).json({ error: "没有收到录音内容" });
        return;
      }

      const appId = process.env.XFYUN_APPID || "";
      const apiSecret = process.env.XFYUN_API_SECRET || "";
      const apiKey = process.env.XFYUN_API_KEY || "";
      if (!appId || !apiSecret || !apiKey) {
        res.status(503).json({ error: "讯飞语音服务未配置" });
        return;
      }

      const startedAt = Date.now();
      const pcmBuffer = await transcodeToPcm(audioBuffer);
      const text = await transcribeWithXfyun({ pcmBuffer, appId, apiSecret, apiKey });
      if (!text) {
        res.status(422).json({ error: "没有识别到清晰语音，请靠近麦克风后重试" });
        return;
      }
      console.info("[voice] transcription completed", {
        inputBytes: audioBuffer.length,
        durationMs: Date.now() - startedAt,
      });
      res.json({ text });
    } catch (err: any) {
      console.error("[voice] error:", err);
      if (err?.message === "EA_AUDIO_TOO_LARGE") {
        res.status(413).json({ error: "录音过大，请缩短后重试" });
        return;
      }
      if (String(err?.message || "").startsWith("EA_AUDIO_TRANSCODE_FAILED")) {
        res.status(400).json({ error: "录音格式暂不支持，请更换浏览器或重新录制" });
        return;
      }
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  app.post("/api/claw/voice/tts", async (req, res) => {
    try {
      if (!(await requireAuthenticatedUser(req, res))) return;
      let text = String((req.body as any)?.text || "").trim();
      if (!text) {
        res.status(400).json({ error: "No text" });
        return;
      }
      if (text.length > 2000) text = text.slice(0, 2000);

      const appId = process.env.XFYUN_APPID || "";
      const apiSecret = process.env.XFYUN_API_SECRET || "";
      const apiKey = process.env.XFYUN_API_KEY || "";
      if (!appId || !apiSecret || !apiKey) {
        res.status(503).json({ error: "TTS service not configured" });
        return;
      }

      const crypto = await import("crypto");
      const host = "tts-api.xfyun.cn";
      const wsPath = "/v2/tts";
      const voice = String(process.env.XFYUN_TTS_VOICE || "xiaoyan").trim() || "xiaoyan";
      const date = new Date().toUTCString();
      const signOrigin = `host: ${host}\ndate: ${date}\nGET ${wsPath} HTTP/1.1`;
      const hmac = crypto.createHmac("sha256", apiSecret);
      hmac.update(signOrigin);
      const sha = hmac.digest("base64");
      const authOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sha}"`;
      const authorization = Buffer.from(authOrigin).toString("base64");
      const wsUrl = `wss://${host}${wsPath}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;

      const { WebSocket: WS } = await import("ws");
      const audioParts: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        const ws = new WS(wsUrl);
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try {
            ws.close();
          } catch {}
          if (error) reject(error);
          else resolve();
        };

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              common: { app_id: appId },
              business: {
                aue: "lame",
                auf: "audio/L16;rate=16000",
                vcn: voice,
                speed: 50,
                volume: 50,
                pitch: 50,
                tte: "UTF8",
              },
              data: {
                status: 2,
                text: Buffer.from(text, "utf8").toString("base64"),
              },
            })
          );
        });

        ws.on("message", (raw: unknown) => {
          try {
            const msg = JSON.parse(String(raw));
            const code = msg.code ?? msg.header?.code;
            if (code !== undefined && code !== 0) {
              const message = msg.message || msg.header?.message || "TTS error " + code;
              console.error("[tts] xfyun error:", code, message);
              finish(new Error(message));
              return;
            }
            const audioData = msg.data?.audio || msg.payload?.audio?.audio;
            if (audioData) {
              audioParts.push(Buffer.from(audioData, "base64"));
            }
            const status = msg.data?.status ?? msg.header?.status ?? msg.payload?.audio?.status;
            if (status === 2) {
              finish(audioParts.length > 0 ? undefined : new Error("讯飞未返回音频数据"));
            }
          } catch (error: any) {
            finish(new Error(error?.message || "讯飞响应解析失败"));
          }
        });

        ws.on("error", (err: Error) => finish(err));
        timeout = setTimeout(() => finish(new Error("讯飞语音合成超时")), 30000);
      });

      const audioBuffer = Buffer.concat(audioParts);
      if (audioBuffer.length === 0) {
        res.status(502).json({ error: "讯飞未返回音频数据" });
        return;
      }
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.length);
      res.send(audioBuffer);
    } catch (err: any) {
      console.error("[tts] error:", err);
      res.status(500).json({ error: err.message || "TTS error" });
    }
  });
}
