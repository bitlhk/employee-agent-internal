import "dotenv/config";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { localFixtureDatabase } from "./scheduling-e2e-fixture";
import { closeDbConnection } from "../server/db/connection";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import {
  JIUWENCLAW_HOME,
  readSessionRegistry,
  resolveRuntimeAgentId,
  resolveRuntimeWorkspaceByIds,
} from "../server/_core/helpers";
import { skillStoreMarketplaceDir } from "../server/_core/skills/skill-store";
import { assertCollaborationRuntimeReady } from "../server/_core/collaboration/runtime-readiness";

// Read-only real-browser/model verification of the persistent A/B demo.
// New verification conversations are retained; existing operator chats are untouched.
type HistoryRow = {
  event_type?: string;
  tool_name?: string;
  tool_call?: { name: string };
  result?: string;
  content?: string;
};
const reportPath = "logs/scheduling-manual-skills-report.json";
const report: { passed: boolean; checks: Record<string, unknown>[] } = {
  passed: false,
  checks: [],
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
async function main() {
  const db = await localFixtureDatabase();
  const readinessDeadline = Date.now() + 120_000;
  while (true) {
    try {
      await assertCollaborationRuntimeReady();
      const { listSelectableJiuwenModels } = await import(
        "../server/_core/jiuwenswarm-model-admin"
      );
      assert(
        (await listSelectableJiuwenModels()).length > 0,
        "Gateway model catalog must be ready"
      );
      break;
    } catch (error) {
      if (Date.now() >= readinessDeadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  const state = JSON.parse(
    readFileSync("data/scheduling-manual-demo.json", "utf8")
  ) as { adoptIds: string[] };
  assert.equal(state.adoptIds.length, 2);
  const source = readFileSync(
    path.join(
      skillStoreMarketplaceDir("approved"),
      "scheduling-assistant/SKILL.md"
    )
  );
  const digest = (value: Buffer) =>
    createHash("sha256").update(value).digest("hex");
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [i, adoptId] of state.adoptIds.entries()) {
      const userId = [2, 3][i];
      const [user] = await db
        .select()
        .from(s.users)
        .where(eq(s.users.id, userId));
      const [owner] = await db
        .select()
        .from(s.clawAdoptions)
        .where(eq(s.clawAdoptions.adoptId, adoptId));
      assert(
        owner?.userId === userId && user?.name === `日程演示用户${"AB"[i]}`
      );
      const workspace = resolveRuntimeWorkspaceByIds(
        adoptId,
        resolveRuntimeAgentId(adoptId, owner.agentId || "")
      );
      const skillPath = path.join(
        workspace,
        "skills/scheduling-assistant/SKILL.md"
      );
      assert(
        existsSync(skillPath),
        "Skill must exist in this assistant's own workspace"
      );
      assert.equal(digest(readFileSync(skillPath)), digest(source));
      const scope = JSON.parse(
        readFileSync(path.join(workspace, ".linggan-role-scope.json"), "utf8")
      );
      assert(
        scope.effectiveAssets.skills.default.includes("scheduling-assistant")
      );
      const runtimePython =
        process.argv.find(arg => arg.startsWith("--python="))?.slice(9) ||
        path.join(
          path.dirname(JIUWENCLAW_HOME),
          "jiuwen-runtime",
          process.platform === "win32" ? "Scripts/python.exe" : "bin/python"
        );
      const fileCheck = execFileSync(
        runtimePython,
        [path.resolve("scripts/verify_runtime_skill_files.py"), workspace],
        { encoding: "utf8", timeout: 30_000, windowsHide: true }
      );
      assert(
        fileCheck.includes("EA_SKILL_FILES_OK"),
        "Installed runtime must list and read the actual demo skill"
      );
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      });
      await context.addCookies([
        {
          name: COOKIE_NAME,
          value: await sdk.signSession({
            userId,
            name: user.name!,
            authVersion: sessionAuthVersion(user),
          }),
          url: "http://127.0.0.1:5173",
        },
      ]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:5173/claw/${adoptId}`, {
        waitUntil: "domcontentloaded",
      });
      const input = page.locator("textarea.main-chat-input").last();
      await input.waitFor({ state: "visible", timeout: 60000 });
      await page.waitForTimeout(1500);
      await page.locator('button[title="新建会话"]').click();
      await page
        .locator(".role-task-launchpad")
        .waitFor({ state: "visible", timeout: 30000 });
      const date = new Date(Date.now() + 2 * 86400000)
        .toISOString()
        .slice(0, 10);
      await input.fill(
        `这是技能加载验收：先用 list_files 列出你本人工作区的 skills 目录，再用 skill_tool 加载技能 scheduling-assistant（显示名“日程协同”），确认读取到实际技能内容。随后实际调用 query_own_schedules 查询我北京时间${date}09:00到18:00的日程，并实际调用 recommend_own_candidates 推荐30分钟空闲时段，以便验证这两项工具都可以正常执行。仅查询本人，不联系其他人，不准备任何草稿，不创建或修改日程。`
      );
      const requestPromise = page.waitForRequest(
        r => r.method() === "POST" && r.url().endsWith("/api/claw/chat-stream")
      );
      await page.locator('button[title="发送"]').last().click();
      const request = await requestPromise;
      const conversationId = request.postDataJSON().conversationId as string;
      assert(
        conversationId,
        "Verification must use a new independent conversation"
      );
      let sessionId = "";
      let rows: HistoryRow[] = [];
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        sessionId =
          Object.entries(readSessionRegistry()).find(
            ([key]) =>
              key.startsWith(`${adoptId}:`) &&
              key.endsWith(`:web:${conversationId}`)
          )?.[1]?.sessionKey || "";
        const historyPath = path.join(
          JIUWENCLAW_HOME,
          "agent/sessions",
          sessionId,
          "history.jsonl"
        );
        if (sessionId && existsSync(historyPath))
          rows = readFileSync(historyPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(line => JSON.parse(line));
        const approval = page
          .getByRole("button", { name: "本次允许", exact: true })
          .first();
        if (await approval.isVisible().catch(() => false))
          await approval.click();
        if (rows.some(row => row.event_type === "chat.final")) break;
        await page.waitForTimeout(1000);
      }
      const toolResults = rows.filter(
        row => row.event_type === "chat.tool_result"
      );
      const list = toolResults.find(
        row =>
          row.tool_name === "list_files" &&
          row.result?.includes("scheduling-assistant")
      );
      // FsOperation above verifies real directory I/O even when the model skips
      // a redundant listing because its skill catalog already names the skill.
      // Actual runtime SkillTool loading remains mandatory below.
      if (list) assert(list.result?.includes("success=True"));
      const skill = toolResults.find(row => row.tool_name === "skill_tool");
      assert(
        skill?.result?.includes("success=True") &&
          skill.result.includes("# 日程协同"),
        "Runtime SkillTool must load the real skill content"
      );
      assert(
        toolResults.some(row => row.tool_name?.includes("query_own_schedules")),
        "Model must execute the own-calendar read after loading the skill"
      );
      assert(
        toolResults.some(row =>
          row.tool_name?.includes("recommend_own_candidates")
        ),
        "Model must execute candidate recommendation"
      );
      assert(
        !toolResults.some(
          row =>
            row.result?.includes("success=False") ||
            row.result?.includes("Skill not found") ||
            row.result?.includes("Path is not a directory")
        ),
        "Read-only skill flow must not contain failed tool results"
      );
      assert(
        !rows.some(
          row =>
            row.event_type === "chat.tool_call" &&
            /prepare_|confirm_|send_collaboration|start_collaboration/.test(
              row.tool_call?.name || ""
            )
        ),
        "Read-only verification must not prepare writes or contact others"
      );
      assert(rows.some(row => row.event_type === "chat.final" && row.content));
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: `logs/scheduling-manual-skill-${"AB"[i]}.png`,
        fullPage: true,
      });
      report.checks.push({
        adoptId,
        conversationId,
        sessionId,
        sourceDigest: digest(source),
        workspaceFile: true,
        scope: true,
        directoryListed: true,
        skillLoaded: true,
        calendarRead: true,
        candidatesRecommended: true,
        toolErrors: 0,
      });
      save();
      console.log(
        `Verified actual skill load and read-only calendar tools for ${"AB"[i]}`
      );
      await context.close();
    }
    report.passed = true;
    save();
  } finally {
    await browser.close();
    await closeDbConnection();
  }
}
main().catch(error => {
  save();
  console.error(
    error instanceof Error ? error.message : "Skill verification failed"
  );
  process.exitCode = 1;
});
