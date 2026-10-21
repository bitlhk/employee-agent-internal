import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { and, eq, gt, desc } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { localFixtureDatabase } from "./scheduling-e2e-fixture";
import { closeDbConnection } from "../server/db/connection";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { requestConversationContinuation } from "../server/db/collaboration-runs";
import { readSessionRegistry } from "../server/_core/helpers";
import { getCalendarCredentials } from "../server/db/scheduling";
import { readOwnCalendar } from "../server/_core/scheduling/calendar";

// Real model + managed worker + browser approval. No injected results or publisher calls.
const report: {
  passed: boolean;
  cases: Record<string, unknown>[];
  errors: string[];
  [key: string]: unknown;
} = { passed: false, cases: [], errors: [] };
const save = () =>
  writeFileSync(
    "logs/collaboration-direct-reply-e2e.json",
    JSON.stringify(report, null, 2)
  );
async function until<T>(
  name: string,
  read: () => Promise<T>,
  accept: (v: T) => boolean,
  timeout = 240000
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await read();
    if (accept(v)) return v;
    await new Promise(r => setTimeout(r, 1200));
  }
  throw new Error(`Timeout: ${name}`);
}
async function main() {
  const db = await localFixtureDatabase();
  const { adoptIds } = JSON.parse(
    readFileSync("data/scheduling-manual-demo.json", "utf8")
  );
  const browser = await chromium.launch({ headless: true });
  const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const range = {
    start: `${date}T00:00:00+08:00`,
    end: `${date}T23:59:59+08:00`,
  };
  const calendar = async () =>
    Promise.all(
      [2, 3].map(async id =>
        readOwnCalendar(id, (await getCalendarCredentials(id))!, range)
      )
    );
  const before = await calendar();
  console.log("Calendar baseline loaded");
  try {
    const contexts = [];
    const pages = [];
    for (const id of [2, 3]) {
      const [user] = await db.select().from(s.users).where(eq(s.users.id, id));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      });
      context.setDefaultTimeout(45000);
      await context.addCookies([
        {
          name: COOKIE_NAME,
          value: await sdk.signSession({
            userId: id,
            name: user.name!,
            authVersion: sessionAuthVersion(user),
          }),
          url: "http://127.0.0.1:5173",
        },
      ]);
      const page = await context.newPage();
      page.on("pageerror", e => report.errors.push(e.message));
      await page.goto(`http://127.0.0.1:5173/claw/${adoptIds[id - 2]}`);
      console.log(`Browser ${id} loaded`);
      await page
        .locator("textarea.main-chat-input")
        .last()
        .waitFor({ timeout: 60000 });
      contexts.push(context);
      pages.push(page);
    }
    const [a, b] = pages;
    for (const action of ["approve", "reject"] as const) {
      const [latest] = await db
        .select({ id: s.clawCollabRequests.id })
        .from(s.clawCollabRequests)
        .orderBy(desc(s.clawCollabRequests.id))
        .limit(1);
      const minId = latest?.id || 0;
      await b.getByRole("button", { name: "新建会话", exact: true }).click();
      await b.locator(".role-task-launchpad").waitFor({ state: "visible" });
      await b.waitForTimeout(500);
      console.log(`Starting ${action} case`);
      const prompt = `请使用日程协同技能，帮我问一下日程演示用户A在北京时间${date}13:00到14:00有没有空。只直接发送一次协作询问，不创建安排会议的整体目标，不创建或修改日历。等对方答复后告诉我结果。`;
      await b.locator("textarea.main-chat-input").last().fill(prompt);
      assert.equal(
        await b.locator("textarea.main-chat-input").last().inputValue(),
        prompt
      );
      const sent = b.waitForRequest(
        r => r.method() === "POST" && r.url().endsWith("/api/claw/chat-stream")
      );
      await b.locator('button[title="发送"]').last().click();
      console.log(`Submitted ${action} query`);
      const conversationId = (await sent).postDataJSON().conversationId;
      const request = await until(
        "direct request",
        async () => {
          const allow = b
            .getByRole("button", { name: "本次允许", exact: true })
            .first();
          if (await allow.isVisible()) await allow.click();
          const [row] = await db
            .select()
            .from(s.clawCollabRequests)
            .where(
              and(
                gt(s.clawCollabRequests.id, minId),
                eq(s.clawCollabRequests.requesterAdoptId, adoptIds[1]),
                eq(s.clawCollabRequests.targetAdoptId, adoptIds[0])
              )
            )
            .limit(1);
          return row;
        },
        v => !!v
      );
      assert.equal(request.status, "pending");
      const continuation = await requestConversationContinuation(request.id);
      assert(
        continuation?.requestKey?.startsWith("reply:"),
        "Must exercise a direct request, not an explicitly delegated goal"
      );
      assert.equal(continuation.status, "waiting");
      assert.equal(continuation.sourceConversationId, conversationId);
      const sessionId = Object.entries(readSessionRegistry()).find(
        ([key]) =>
          key.startsWith(`${adoptIds[1]}:`) &&
          key.endsWith(`:web:${conversationId}`)
      )?.[1]?.sessionKey;
      assert.equal(continuation.sourceSessionId, sessionId);
      const item: Record<string, unknown> = {
        action,
        requestId: request.id,
        runId: continuation.id,
        conversationId,
        sourceSessionId: sessionId,
        initialStatus: continuation.status,
      };
      report.cases.push(item);
      save();
      console.log(JSON.stringify({ phase: "waiting", ...item }));
      await a.reload();
      await a
        .locator("textarea.main-chat-input")
        .last()
        .waitFor({ timeout: 60000 });
      await a.getByText("工作区动态", { exact: true }).first().click();
      const card = a.locator(`[data-collaboration-request-id="${request.id}"]`);
      await card
        .getByRole("button", {
          name: action === "approve" ? "批准本次协作" : "拒绝",
          exact: true,
        })
        .waitFor({ timeout: 60000 });
      await card
        .getByRole("button", {
          name: action === "approve" ? "批准本次协作" : "拒绝",
          exact: true,
        })
        .click();
      await until(
        "clear approval state",
        () => card.textContent(),
        v => !!v?.includes(action === "approve" ? "已批准" : "你已拒绝"),
        30000
      );
      item.approvalState = await card.textContent();
      save();
      const done = await until(
        "automatic model continuation",
        async () => {
          const [run] = await db
            .select()
            .from(s.collaborationRuns)
            .where(eq(s.collaborationRuns.id, continuation.id));
          return run;
        },
        v => v.status === "completed"
      );
      assert(done.publicMessage);
      assert(
        !/calendarChanged|已在原对话|我查了你自己的日历/.test(
          done.publicMessage
        ),
        "Reply must address the requester without internal fields or reversing participants"
      );
      assert(
        done.publicMessage.includes("A"),
        "Reply must identify the actual recipient"
      );
      assert(done.turn > 0);
      const [finalRequest] = await db
        .select()
        .from(s.clawCollabRequests)
        .where(eq(s.clawCollabRequests.id, request.id));
      assert.equal(
        finalRequest.status,
        action === "approve" ? "completed" : "rejected"
      );
      const history = async () => {
        const res = await contexts[1].request.get(
          `http://127.0.0.1:5174/api/claw/chat-history/messages?${new URLSearchParams({ adoptId: adoptIds[1], sessionKey: sessionId! })}`
        );
        assert(res.ok());
        return (await res.json()).messages as {
          text?: string;
          role?: string;
        }[];
      };
      const messages = await until(
        "original conversation delivery",
        history,
        rows => rows.some(m => m.text === done.publicMessage)
      );
      assert.equal(
        messages.filter(m => m.text === done.publicMessage).length,
        1
      );
      assert.equal(
        messages.filter(m => m.role === "user").length,
        1,
        "No follow-up user prompt should be needed"
      );
      const visibleReply = done.publicMessage
        .split("\n")
        .find(line => line.trim())!
        .replace(/[*_`#]/g, "")
        .trim();
      await b
        .getByText(visibleReply, { exact: false })
        .first()
        .waitFor({ timeout: 45000 });
      if (action === "approve")
        await until(
          "completed approval card",
          () => card.textContent(),
          v => !!v?.includes("助手已完成"),
          30000
        );
      assert(!(await card.textContent())?.includes("已失效"));
      await b.reload();
      await b
        .locator("textarea.main-chat-input")
        .last()
        .waitFor({ timeout: 60000 });
      await b
        .getByText(visibleReply, { exact: false })
        .first()
        .waitFor({ timeout: 30000 });
      const reread = await history();
      assert.equal(reread.filter(m => m.text === done.publicMessage).length, 1);
      await b.screenshot({
        path: `logs/collaboration-direct-${action}-reply.png`,
        fullPage: true,
      });
      await a.screenshot({
        path: `logs/collaboration-direct-${action}-status.png`,
        fullPage: true,
      });
      item.finalStatus = done.status;
      item.turns = done.turn;
      item.reply = done.publicMessage;
      item.originalConversationVisible = true;
      item.persistedOnce = true;
      save();
      console.log(JSON.stringify({ phase: "complete", ...item }));
    }
    assert.deepEqual(
      await calendar(),
      before,
      "Read-only collaboration must leave both calendars unchanged"
    );
    assert.deepEqual(report.errors, []);
    report.calendarsUnchanged = true;
    report.passed = true;
    save();
  } finally {
    await browser.close();
  }
}
main()
  .then(() => closeDbConnection())
  .catch(async error => {
    report.error = String(error);
    save();
    console.error(error);
    await closeDbConnection();
    process.exitCode = 1;
  });
