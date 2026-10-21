import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  clawAdoptions,
  collaborationRuns,
  collaborationWaits,
} from "../drizzle/schema";
import { getDb, closeDbConnection } from "../server/db/connection";
import {
  createCollaborationGoal,
  getCollaborationRun,
} from "../server/db/collaboration-runs";
import { resolveRuntimeWorkspaceByIds } from "../server/_core/helpers";
import { writeSkillValueEvaluationToolScope } from "../server/_core/skill-value-evaluation-tool-scope";
import { recoverCollaborationWork } from "../server/_core/collaboration/worker";
import { executeCollaborationTurn } from "../server/_core/collaboration/runtime";
import {
  issueInternalRuntimeToken,
  internalMcpAudience,
} from "../server/_core/internal-runtime-token";
import { runSessionId } from "../server/db/collaboration-runs";

// Explicit smoke test: a disposable assistant may only checkpoint and finish a
// read goal. It cannot contact people, read calendars or prepare any writes.
async function main() {
  const userId = Number(
    process.argv.find(arg => arg.startsWith("--user-id="))?.split("=")[1]
  );
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error("--user-id=<existing test owner> is required");
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const adoptId = `lgj-eval-collab-${randomUUID().slice(0, 8)}`;
  const agentId = `smoke_${randomUUID().replace(/-/g, "")}`;
  let goalId: string | undefined;
  try {
    await db
      .insert(clawAdoptions)
      .values({
        userId,
        adoptId,
        agentId,
        status: "active",
        permissionProfile: "plus",
        roleTemplate: "general-assistant",
        runtime: "jiuwenswarm",
        entryUrl: `/claw/${adoptId}`,
      });
    writeSkillValueEvaluationToolScope({
      workspaceDir: resolveRuntimeWorkspaceByIds(adoptId, agentId),
      mcpServers: [
        {
          serverId: "platform_tools",
          requiredTools: [
            "checkpoint_collaboration_goal",
            "finish_collaboration_goal",
          ],
        },
      ],
    });
    const run = await createCollaborationGoal({
      userId,
      adoptId,
      requestKey: randomUUID(),
      taskType: "scheduling",
      expectedEffect: "read",
      sourceSessionId: `smoke-${randomUUID()}`,
      sourceConversationId: null,
      objective:
        '这是受限运行验证。不要找人、访问日历或其他系统。仅调用 checkpoint_collaboration_goal 保存 "smoke verified"，然后调用 finish_collaboration_goal，message="受限运行验证完成"，evidence=[]。必须实际调用工具，不能只回复文字。',
    });
    goalId = run.id;
    const toolsOnly = process.argv.includes("--tools-only");
    console.log(
      JSON.stringify({
        phase: "started",
        goalId,
        mode: toolsOnly ? "tools-only-no-model" : "real-model",
      })
    );
    await recoverCollaborationWork(
      async (...args) => {
        const [current, capability] = args;
        if (toolsOnly) {
          const sessionId = runSessionId(current.id, current.turn);
          const base =
            process.env.WORKFORCE_AGENT_INTERNAL_BASE_URL ||
            "http://127.0.0.1:5174";
          const hook = await fetch(`${base}/api/internal/security/pre-tool`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-internal-key": process.env.INTERNAL_API_KEY!,
              "x-linggan-runtime-id": "jiuwenswarm-local",
              "x-linggan-hook-version": "ea-governance-v1",
            },
            body: JSON.stringify({
              session_id: sessionId,
              tool_name: "mcp_platform_tools_checkpoint_collaboration_goal",
              tool_input: { checkpoint: "smoke verified", message: "checking" },
            }),
          });
          if ((await hook.json()).decision !== "allow")
            throw new Error("A valid isolated pre-tool call was denied");
          const invoke = async (
            method: string,
            params?: Record<string, unknown>
          ) => {
            const bearer = await issueInternalRuntimeToken({
              runtimeId: "jiuwenswarm-local",
              agentId,
              adoptId,
              audience: internalMcpAudience("/api/internal/platform-tools/mcp"),
            });
            const response = await fetch(
              `${base}/api/internal/platform-tools/mcp`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${bearer.token}`,
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                  "x-jiuwen-channel-id": adoptId,
                  "x-linggan-agent-id": agentId,
                  "x-linggan-session-id": sessionId,
                  "x-ea-collaboration-run-id": current.id,
                  "x-ea-collaboration-capability": capability,
                  "x-ea-authorization-snapshot-id":
                    current.authorizationSnapshotId!,
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: randomUUID(),
                  method,
                  params,
                }),
              }
            );
            if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
            return response.json() as Promise<{
              error?: { message: string };
              result?: { isError?: boolean; tools?: { name: string }[] };
            }>;
          };
          const catalog = await invoke("tools/list");
          if (
            catalog.error ||
            catalog.result?.tools?.length !== 2 ||
            catalog.result.tools.some(
              tool =>
                ![
                  "checkpoint_collaboration_goal",
                  "finish_collaboration_goal",
                ].includes(tool.name)
            )
          )
            throw new Error(
              "Evaluation and isolated tool scopes were not intersected"
            );
          const denied = await invoke("tools/call", {
            name: "query_own_schedules",
            arguments: {},
          });
          if (!denied.error && !denied.result?.isError)
            throw new Error("Evaluation scope permitted a real calendar read");
          for (const [name, arguments_] of [
            [
              "checkpoint_collaboration_goal",
              { checkpoint: "smoke verified", message: "受限工具验证" },
            ],
            [
              "finish_collaboration_goal",
              { message: "受限工具验证完成", evidence: [] },
            ],
          ] as const) {
            const response = await invoke("tools/call", {
              name,
              arguments: arguments_,
            });
            if (response.error || response.result?.isError)
              throw new Error(
                response.error?.message || "Platform tool failed"
              );
          }
          return "工具验证完成（未调用模型）";
        }
        try {
          return await executeCollaborationTurn(...args);
        } catch (error) {
          console.error(
            error instanceof Error ? error.message : "Runtime turn failed"
          );
          throw error;
        }
      },
      { adoptIds: [adoptId] }
    );
    const latest = await getCollaborationRun(run.id);
    console.log(
      JSON.stringify({
        phase: "result",
        status: latest?.status,
        checkpoint: latest?.checkpoint,
        message: latest?.publicMessage,
      })
    );
    if (
      latest?.status !== "completed" ||
      !latest.checkpoint?.includes("smoke verified")
    )
      throw new Error(
        "Real runtime did not checkpoint and complete through platform tools"
      );
  } finally {
    if (goalId) {
      await db
        .delete(collaborationWaits)
        .where(eq(collaborationWaits.runId, goalId));
      await db
        .delete(collaborationRuns)
        .where(eq(collaborationRuns.id, goalId));
    }
    await db.delete(clawAdoptions).where(eq(clawAdoptions.adoptId, adoptId));
  }
}
main()
  .catch(error => {
    console.error(
      error instanceof Error ? error.message : "Runtime verification failed"
    );
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
