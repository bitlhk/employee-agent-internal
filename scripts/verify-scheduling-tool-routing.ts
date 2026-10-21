import "dotenv/config";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { localFixtureDatabase } from "./scheduling-e2e-fixture";
import { closeDbConnection } from "../server/db/connection";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { JIUWENCLAW_HOME, readSessionRegistry } from "../server/_core/helpers";
import { assertCollaborationRuntimeReady } from "../server/_core/collaboration/runtime-readiness";

type Row = {
  event_type?: string;
  content?: string;
  tool_name?: string;
  result?: string;
  tool_call?: { name: string; arguments: string };
};
const report: { passed: boolean; cases: Record<string, unknown>[] } = {
  passed: false,
  cases: [],
};
const save = () =>
  writeFileSync(
    "logs/scheduling-tool-routing-report.json",
    JSON.stringify(report, null, 2)
  );
async function main() {
  const db = await localFixtureDatabase();
  await assertCollaborationRuntimeReady();
  const state = JSON.parse(
    readFileSync("data/scheduling-manual-demo.json", "utf8")
  ) as { adoptIds: string[] };
  const adoptId = state.adoptIds[0];
  const [owner] = await db
    .select()
    .from(s.clawAdoptions)
    .where(eq(s.clawAdoptions.adoptId, adoptId));
  const [user] = await db.select().from(s.users).where(eq(s.users.id, 2));
  assert(owner?.userId === 2 && user.name === "日程演示用户A");
  const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const cases = [
    {
      name: "events-only",
      query: 1,
      recommend: 0,
      prompt: `请使用日程协同技能，只查看我北京时间${date}09:00到18:00已有的日程安排，不需要推荐空闲时间。不要联系别人，也不要创建或修改日程。`,
    },
    {
      name: "recommend-only",
      query: 0,
      recommend: 1,
      prompt: `请使用日程协同技能，推荐我北京时间${date}09:00到18:00之间适合30分钟会议的空闲时间；只要推荐，不需要列出已有日程。不要联系别人，也不要创建或修改日程。`,
    },
    {
      name: "events-and-recommendations",
      query: 1,
      recommend: 1,
      prompt: `请使用日程协同技能，查看我北京时间${date}09:00到18:00已有的日程明细，同时推荐适合30分钟会议的空闲时间。不要联系别人，也不要创建或修改日程。`,
    },
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const item of cases) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      });
      await context.addCookies([
        {
          name: COOKIE_NAME,
          value: await sdk.signSession({
            userId: 2,
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
      await page.getByRole("button", { name: "新建会话", exact: true }).click();
      await page
        .locator(".role-task-launchpad")
        .waitFor({ state: "visible", timeout: 30000 });
      await input.fill(item.prompt);
      const sent = page.waitForRequest(
        request =>
          request.method() === "POST" &&
          request.url().endsWith("/api/claw/chat-stream")
      );
      await page.locator('button[title="发送"]').last().click();
      const conversationId = (await sent).postDataJSON()
        .conversationId as string;
      assert(conversationId);
      let rows: Row[] = [];
      let sessionId = "";
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        sessionId =
          Object.entries(readSessionRegistry()).find(
            ([key]) =>
              key.startsWith(`${adoptId}:`) &&
              key.endsWith(`:web:${conversationId}`)
          )?.[1]?.sessionKey || "";
        const file = path.join(
          JIUWENCLAW_HOME,
          "agent/sessions",
          sessionId,
          "history.jsonl"
        );
        if (sessionId && existsSync(file))
          rows = readFileSync(file, "utf8")
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
      assert(
        rows.some(row => row.event_type === "chat.final" && row.content),
        `${item.name}: no final answer`
      );
      const calls = rows.filter(row => row.event_type === "chat.tool_call");
      const results = rows.filter(row => row.event_type === "chat.tool_result");
      const count = (name: string) =>
        calls.filter(row => row.tool_call?.name.endsWith(name)).length;
      assert.equal(
        count("query_own_schedules"),
        item.query,
        `${item.name}: unnecessary/missing event query`
      );
      assert.equal(
        count("recommend_own_candidates"),
        item.recommend,
        `${item.name}: unnecessary/missing recommendation`
      );
      assert(
        results.some(
          row =>
            ["read_file", "skill_tool"].includes(row.tool_name || "") &&
            row.result?.includes("# 日程协同")
        ),
        "Actual skill content must be loaded"
      );
      assert(
        !results.some(row =>
          /success=False|Skill not found|Path is not a directory|["']isError["']\s*:\s*(?:true|True)/.test(
            row.result || ""
          )
        ),
        `${item.name}: tool error`
      );
      assert(
        !calls.some(row =>
          /prepare_|confirm_|collaboration|coordinate_meeting|search_.*people/.test(
            row.tool_call?.name || ""
          )
        ),
        "Personal read requests must not start collaboration or writes"
      );
      assert.deepEqual(errors, []);
      report.cases.push({
        name: item.name,
        conversationId,
        sessionId,
        skillLoaded: true,
        eventQueries: item.query,
        recommendations: item.recommend,
        toolErrors: 0,
      });
      save();
      console.log(
        `Passed ${item.name}: query=${item.query}, recommend=${item.recommend}`
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
    error instanceof Error ? error.message : "Routing verification failed"
  );
  process.exitCode = 1;
});
