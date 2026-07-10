import express from "express";
import { resolveRequesterUserId } from "./helpers";

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
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const audioBuffer = Buffer.concat(chunks);
        if (audioBuffer.length === 0) {
          res.status(400).json({ error: "No audio data" });
          return;
        }
        if (audioBuffer.length > 50 * 1024 * 1024) {
          res.status(413).json({ error: "Audio too large" });
          return;
        }

        const appId = process.env.XFYUN_APPID || "";
        const apiSecret = process.env.XFYUN_API_SECRET || "";
        const apiKey = process.env.XFYUN_API_KEY || "";
        if (!appId || !apiSecret || !apiKey) {
          res.status(503).json({ error: "讯飞语音服务未配置" });
          return;
        }

        const { execSync } = await import("child_process");
        const { writeFileSync, readFileSync, unlinkSync } = await import("fs");
        const tmpIn = `/tmp/voice_${Date.now()}.webm`;
        const tmpOut = `/tmp/voice_${Date.now()}.pcm`;
        writeFileSync(tmpIn, audioBuffer);
        try {
          execSync(
            `ffmpeg -y -i ${tmpIn} -ar 16000 -ac 1 -f s16le ${tmpOut} 2>/dev/null`
          );
        } catch {
          try {
            unlinkSync(tmpIn);
          } catch {}
          res
            .status(400)
            .json({ error: "音频格式转换失败，请确认 ffmpeg 已安装" });
          return;
        }
        const pcmBuffer = readFileSync(tmpOut);
        try {
          unlinkSync(tmpIn);
          unlinkSync(tmpOut);
        } catch {}

        const crypto = await import("crypto");
        const host = "iat-api.xfyun.cn";
        const path = "/v2/iat";
        const date = new Date().toUTCString();
        const signOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
        const hmac = crypto.createHmac("sha256", apiSecret);
        hmac.update(signOrigin);
        const sha = hmac.digest("base64");
        const authOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sha}"`;
        const authorization = Buffer.from(authOrigin).toString("base64");
        const wsUrl = `wss://${host}${path}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;

        const { WebSocket: WS } = await import("ws");
        const textParts: string[] = [];

        await new Promise<void>((resolve, reject) => {
          const ws = new WS(wsUrl);
          let offset = 0;
          const frameBytes = 1280;
          let frameIdx = 0;
          let sendTimer: ReturnType<typeof setInterval> | null = null;

          ws.on("open", () => {
            sendTimer = setInterval(() => {
              if (offset >= pcmBuffer.length) {
                ws.send(
                  JSON.stringify({
                    common: frameIdx === 0 ? { app_id: appId } : undefined,
                    business:
                      frameIdx === 0
                        ? {
                            language: "zh_cn",
                            domain: "iat",
                            accent: "mandarin",
                            vad_eos: 3000,
                            dwa: "wpgs",
                          }
                        : undefined,
                    data: {
                      status: 2,
                      format: "audio/L16;rate=16000",
                      encoding: "raw",
                      audio: Buffer.alloc(0).toString("base64"),
                    },
                  })
                );
                if (sendTimer) clearInterval(sendTimer);
                return;
              }
              const end = Math.min(offset + frameBytes, pcmBuffer.length);
              const frame = pcmBuffer.subarray(offset, end);
              const status = frameIdx === 0 ? 0 : 1;
              ws.send(
                JSON.stringify({
                  common: frameIdx === 0 ? { app_id: appId } : undefined,
                  business:
                    frameIdx === 0
                      ? {
                          language: "zh_cn",
                          domain: "iat",
                          accent: "mandarin",
                          vad_eos: 3000,
                          dwa: "wpgs",
                        }
                      : undefined,
                  data: {
                    status,
                    format: "audio/L16;rate=16000",
                    encoding: "raw",
                    audio: frame.toString("base64"),
                  },
                })
              );
              offset = end;
              frameIdx++;
            }, 40);
          });

          ws.on("message", (raw: unknown) => {
            try {
              const msg = JSON.parse(String(raw));
              if (msg.code !== 0) {
                console.error("[xfyun] error:", msg.code, msg.message);
                ws.close();
                reject(new Error(msg.message || "讯飞识别错误 " + msg.code));
                return;
              }
              const wsArr = msg.data?.result?.ws || [];
              for (const w of wsArr) {
                for (const cw of w.cw || []) {
                  textParts.push(cw.w || "");
                }
              }
              if (msg.data?.status === 2) {
                ws.close();
                resolve();
              }
            } catch {}
          });

          ws.on("error", (err: Error) => {
            if (sendTimer) clearInterval(sendTimer);
            reject(err);
          });

          ws.on("close", () => {
            if (sendTimer) clearInterval(sendTimer);
          });

          setTimeout(() => {
            try {
              ws.close();
            } catch {}
            resolve();
          }, 30000);
        });

        const text = textParts.join("").trim();
        res.json({ text });
      });
    } catch (err: any) {
      console.error("[voice] error:", err);
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
      const host = "cbm01.cn-huabei-1.xf-yun.com";
      const wsPath = "/v1/private/mcd9m97e6";
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

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              header: { app_id: appId, status: 2 },
              parameter: {
                oral: { oral_level: "mid" },
                tts: {
                  vcn: "x6_lingxiaoxuan_pro",
                  speed: 50,
                  volume: 50,
                  pitch: 50,
                  bgs: 0,
                  reg: 0,
                  rdn: 0,
                  rhy: 0,
                  audio: {
                    encoding: "lame",
                    sample_rate: 24000,
                    channels: 1,
                    bit_depth: 16,
                    frame_size: 0,
                  },
                },
              },
              payload: {
                text: {
                  encoding: "utf8",
                  compress: "raw",
                  format: "plain",
                  status: 2,
                  seq: 0,
                  text: Buffer.from(text, "utf8").toString("base64"),
                },
              },
            })
          );
        });

        ws.on("message", (raw: unknown) => {
          try {
            const msg = JSON.parse(String(raw));
            const code = msg.header?.code ?? msg.code;
            if (code !== undefined && code !== 0) {
              console.error(
                "[tts] xfyun error:",
                code,
                msg.header?.message || msg.message
              );
              ws.close();
              reject(
                new Error(
                  msg.header?.message || msg.message || "TTS error " + code
                )
              );
              return;
            }
            const audioData = msg.payload?.audio?.audio || msg.data?.audio;
            if (audioData) {
              audioParts.push(Buffer.from(audioData, "base64"));
            }
            const status =
              msg.header?.status ??
              msg.payload?.audio?.status ??
              msg.data?.status;
            if (status === 2) {
              ws.close();
              resolve();
            }
          } catch {}
        });

        ws.on("error", (err: Error) => reject(err));
        setTimeout(() => {
          try {
            ws.close();
          } catch {}
          resolve();
        }, 30000);
      });

      const audioBuffer = Buffer.concat(audioParts);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.length);
      res.send(audioBuffer);
    } catch (err: any) {
      console.error("[tts] error:", err);
      res.status(500).json({ error: err.message || "TTS error" });
    }
  });
}
