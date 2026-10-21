import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Response } from "express";
import type { CollaborationRun } from "../../../drizzle/schema";
import { getClawByAdoptId } from "../../db";
import { runSessionId, getCollaborationRun } from "../../db/collaboration-runs";
import {
  forwardToJiuwenClaw,
  isJiuwenClawRuntimeEnabled,
} from "../jiuwenclaw-bridge";
import { APP_ROOT } from "../helpers";
import { assertCollaborationRuntimeReady } from "./runtime-readiness";

export const isolatedCollaborationRuntimeEnabled = () =>
  isJiuwenClawRuntimeEnabled() &&
  process.env.EA_COLLABORATION_RUNTIME_ENABLED === "true";
export class CollaborationRuntimeUnavailable extends Error {}

export function isCollaborationTurnCurrent(
  original: Pick<CollaborationRun, "leaseToken">,
  latest: Pick<CollaborationRun, "status" | "leaseToken" | "leaseUntil"> | null,
  now = Date.now()
) {
  return Boolean(
    latest &&
      latest.status === "running" &&
      latest.leaseToken === original.leaseToken &&
      latest.leaseUntil &&
      latest.leaseUntil.getTime() > now
  );
}

// Express-compatible sink: runs continue without an open browser or a fake login.
export class CollaborationSseSink extends EventEmitter {
  writableEnded = false;
  headersSent = false;
  statusCode = 200;
  text = "";
  error = false;
  errorMessage = "";
  private pending = "";
  private bytes = 0;
  setHeader() {
    return this;
  }
  flushHeaders() {
    this.headersSent = true;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(value: unknown) {
    this.error = true;
    this.end();
    return value;
  }
  write(chunk: unknown) {
    this.bytes += Buffer.byteLength(String(chunk));
    if (this.bytes > 2_000_000) {
      this.error = true;
      throw new Error("Collaboration stream exceeded limit");
    }
    this.pending += String(chunk);
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.__stream_error || data.error) {
          this.error = true;
          this.errorMessage = String(
            data.message ||
              data.error ||
              data.choices?.[0]?.delta?.content ||
              "Runtime stream error"
          ).slice(0, 400);
        }
        if (typeof data.__final_text === "string")
          this.text = data.__final_text;
        else if (typeof data.choices?.[0]?.delta?.content === "string")
          this.text += data.choices[0].delta.content;
      } catch {
        /* Non-JSON SSE payload is not a completion proof. */
      }
    }
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }
}
export async function executeCollaborationTurn(
  run: CollaborationRun,
  token: string,
  prompt: string
) {
  if (!isolatedCollaborationRuntimeEnabled())
    throw new CollaborationRuntimeUnavailable("受限协作运行服务尚未启用");
  const owner = await getClawByAdoptId(run.adoptId);
  if (
    !owner ||
    owner.userId !== run.userId ||
    owner.permissionProfile === "starter" ||
    !["active", "expiring"].includes(owner.status)
  )
    throw new Error("协作身份已失效");
  try {
    await assertCollaborationRuntimeReady();
  } catch (error) {
    throw new CollaborationRuntimeUnavailable(
      error instanceof Error ? error.message : "协作运行服务不可用"
    );
  }
  // Outside the application's Git tree and the owner's normal workspace. No
  // user memory, private files, other skills or chat history are copied here.
  const root =
    process.env.EA_COLLABORATION_WORKSPACE_ROOT ||
    path.join(path.dirname(APP_ROOT), ".employee-agent-collaboration");
  const workspaceDir = path.join(
    root,
    run.id,
    String(run.turn),
    `agent_${owner.agentId}`
  );
  mkdirSync(workspaceDir, { recursive: true });
  const sessionId = runSessionId(run.id, run.turn);
  writeFileSync(
    path.join(workspaceDir, ".linggan-role-scope.json"),
    JSON.stringify({
      version: 1,
      effectiveAssets: {
        skills: { default: [], optional: [] },
        mcpServers: { default: ["platform_tools"], optional: [] },
      },
    })
  );
  writeFileSync(
    path.join(workspaceDir, ".linggan-collaboration-scope.json"),
    JSON.stringify({
      version: 1,
      runId: run.id,
      sessionId,
      capability: token,
      agentId: owner.agentId,
      adoptId: owner.adoptId,
      authorizationSnapshotId: run.authorizationSnapshotId,
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    path.join(workspaceDir, "AGENTS.md"),
    "Only the platform-authorized collaboration tools are permitted. Do not read files, memory, other conversations or business systems. Calendar writes require owner confirmation.\n"
  );
  const sink = new CollaborationSseSink();
  let outcome: string | undefined;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const latest = await getCollaborationRun(run.id);
      if (!isCollaborationTurnCurrent(run, latest)) sink.emit("close");
    } catch {
      sink.emit("close");
    } finally {
      checking = false;
    }
  }, 1000);
  timer.unref();
  try {
    await forwardToJiuwenClaw(owner, prompt, sink as unknown as Response, {
      collaboration: {
        workspaceDir,
        sessionId,
        runtimeAgentId: `collab_${run.id.replace(/-/g, "")}_${run.turn}`,
      },
      channel: "collaboration",
      conversationId: run.id,
      onRuntimeOutcome: value => {
        outcome = value;
      },
    });
  } finally {
    clearInterval(timer);
  }
  const latest = await getCollaborationRun(run.id);
  if (latest && latest.status !== "running")
    return latest.publicMessage || sink.text.slice(0, 6000);
  if (
    sink.error ||
    sink.statusCode >= 400 ||
    (outcome && outcome !== "success")
  )
    throw new Error(
      `协作运行尚未成功，保留检查点后重试：${sink.errorMessage || outcome || sink.statusCode}`
    );
  return sink.text.slice(0, 6000);
}
