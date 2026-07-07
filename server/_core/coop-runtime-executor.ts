import { existsSync, readdirSync, statSync } from "fs";
import { appendLogAsync, generateFileToken, openClawAgentDir, openClawWorkspaceDir } from "./helpers";

export type CoopRuntimeExecutionArgs = {
  requestId: number;
  targetAdoptId: string;
  claw: any;
  collabReq: any;
  execScope: any;
  scopeSystemPrompt: string;
  userMessage: string;
  onChunk?: (chunk: string) => void;
  onDone?: (status: string, result: string) => void;
};

export type CoopRuntimeExecutor = {
  protocol: string;
  execute(args: CoopRuntimeExecutionArgs): Promise<void>;
};

function resolveOpenClawRuntimeAgentId(targetAdoptId: string, claw: any) {
  const dbAgentId = String(claw?.agentId || "").trim();
  const trialAgentId = "trial_" + String(targetAdoptId);
  const trialAgentDir = openClawAgentDir(trialAgentId);
  return existsSync(trialAgentDir) ? trialAgentId : dbAgentId;
}

const openClawGatewayExecutor: CoopRuntimeExecutor = {
  protocol: "openclaw-gateway",
  async execute(args) {
    const { updateCollabRequest } = await import("../db");
    const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
    const gatewayPort = parseInt(process.env.CLAW_GATEWAY_PORT || "18789", 10);
    const gatewayToken = process.env.CLAW_GATEWAY_TOKEN || "";
    const runtimeAgentId = resolveOpenClawRuntimeAgentId(args.targetAdoptId, args.claw);
    const collabSessionKey = "agent:" + runtimeAgentId + ":collab:" + args.requestId;

    const gatewayBody = JSON.stringify({
      model: "openclaw",
      stream: true,
      messages: [
        { role: "system", content: args.scopeSystemPrompt },
        { role: "user", content: args.userMessage },
      ],
    });

    await new Promise<void>(async (resolve) => {
      const http = await import("http");
      const options = {
        hostname: remoteHost,
        port: gatewayPort,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(gatewayBody),
          Authorization: "Bearer " + gatewayToken,
          "x-openclaw-agent-id": runtimeAgentId,
          "x-openclaw-session-key": collabSessionKey,
        },
      };

      let resultText = "";
      const proxyReq = http.request(options, async (proxyRes) => {
        proxyRes.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString("utf8").split("\n")) {
            if (line.startsWith("data:") && !line.includes("[DONE]")) {
              try {
                const d = JSON.parse(line.slice(5));
                const t = d.choices?.[0]?.delta?.content || "";
                if (t) {
                  resultText += t;
                  args.onChunk?.(t);
                }
              } catch {}
            }
          }
        });
        proxyRes.on("end", async () => {
          try {
            const forbidden = ["session_id", "memory_id", "agent_id", "user_id:", "adoptId:", "sessionKey", "token:", "password", "secret"];
            const found = forbidden.filter((kw) => resultText.toLowerCase().includes(kw.toLowerCase()));
            if (found.length > 0) {
              await updateCollabRequest(args.requestId, {
                status: "failed",
                resultSummary: "[安全拦截] 执行结果包含禁止内容，已拦截。",
                completedAt: new Date(),
              } as any);
              args.onDone?.("failed", "[安全拦截]");
              resolve();
              return;
            }

            const maxLen = args.execScope?.maxOutputLength || 2000;
            const safeResult = resultText.slice(0, maxLen);
            const collabArtifacts: Array<{ type: string; name: string; url: string; exp: number }> = [];
            try {
              const outputDir = `${openClawWorkspaceDir(runtimeAgentId)}/output`;
              const collabStartMs = Date.now() - 300_000;
              const tokenTtl = 86400;
              if (existsSync(outputDir)) {
                const scanForFiles = (dir: string, relBase: string) => {
                  try {
                    for (const entry of readdirSync(dir)) {
                      if (entry.startsWith(".")) continue;
                      const full = `${dir}/${entry}`;
                      const rel = relBase ? `${relBase}/${entry}` : entry;
                      try {
                        const st = statSync(full);
                        if (st.isFile() && st.mtimeMs >= collabStartMs) {
                          const token = generateFileToken(String(args.targetAdoptId), runtimeAgentId, `output/${rel}`, tokenTtl);
                          const exp = Math.floor(Date.now() / 1000) + tokenTtl;
                          collabArtifacts.push({ type: "file", name: entry, url: `/api/claw/files/download?token=${encodeURIComponent(token)}`, exp });
                        } else if (st.isDirectory()) {
                          scanForFiles(full, rel);
                        }
                      } catch {}
                    }
                  } catch {}
                };
                scanForFiles(outputDir, "");
              }
            } catch {}

            let finalResult = safeResult;
            if (collabArtifacts.length > 0) {
              const links = collabArtifacts.map((a) => `【下载】${a.name}: ${a.url}（24小时有效）`).join("\n");
              finalResult = `${safeResult}\n\n——\n产出文件（点击链接下载）：\n${links}`;
            }

            const autoEnvelope = {
              status: "success",
              summary: safeResult,
              structured_outputs: { raw_text: safeResult },
              artifacts: collabArtifacts,
              confidence: null,
              executor: openClawGatewayExecutor.protocol,
            };
            await updateCollabRequest(args.requestId, {
              status: "completed",
              resultSummary: finalResult,
              completedAt: new Date(),
              resultMeta: JSON.stringify(autoEnvelope),
            } as any);
            appendLogAsync("claw-collab.log", {
              ts: new Date().toISOString(),
              event: "collab_exec_completed",
              requestId: args.requestId,
              targetAdoptId: args.targetAdoptId,
              runtimeAgentId,
              executor: openClawGatewayExecutor.protocol,
              resultLength: finalResult.length,
              artifacts: collabArtifacts.length,
            });
            args.onDone?.("completed", finalResult);
          } catch {
            await updateCollabRequest(args.requestId, { status: "failed", completedAt: new Date() } as any);
            args.onDone?.("failed", "");
          }
          resolve();
        });
      });
      proxyReq.on("error", async () => {
        await updateCollabRequest(args.requestId, { status: "failed", completedAt: new Date() } as any);
        args.onDone?.("failed", "");
        resolve();
      });
      proxyReq.write(gatewayBody);
      proxyReq.end();
    });
  },
};

export function getCoopRuntimeExecutor(_runtime?: string | null): CoopRuntimeExecutor {
  return openClawGatewayExecutor;
}
