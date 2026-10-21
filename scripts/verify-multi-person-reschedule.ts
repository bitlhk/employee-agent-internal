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
import { readSessionRegistry } from "../server/_core/helpers";
import { getCalendarCredentials } from "../server/db/scheduling";
import { readOwnCalendar } from "../server/_core/scheduling/calendar";
import { webConversationStorageKey } from "../client/src/lib/chat-session-state";

const report: {
  passed: boolean;
  phases: Record<string, unknown>[];
  errors: string[];
  [key: string]: unknown;
} = { passed: false, phases: [], errors: [] };
function log(phase: string, details: Record<string, unknown> = {}) {
  report.phases.push({ at: new Date().toISOString(), phase, ...details });
  writeFileSync(
    "logs/multi-person-reschedule-e2e.json",
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify({ phase, ...details }));
}
async function main() {
  const db = await localFixtureDatabase();
  const state = JSON.parse(
    readFileSync("data/multi-person-calendar-demo.json", "utf8")
  );
  const readCalendars = () =>
    Promise.all(
      (state.userIds as number[]).map(async (id: number) =>
        readOwnCalendar(id, (await getCalendarCredentials(id))!, {
          start: `${state.date}T00:00:00+08:00`,
          end: `${state.date}T23:59:59+08:00`,
        })
      )
    );
  const before = await readCalendars();
  const resumeConversation = process.argv
    .find(arg => arg.startsWith("--conversation="))
    ?.slice(15);
  const browser = await chromium.launch({ headless: true });
  try {
    const contexts = [],
      pages = [];
    for (const [i, id] of state.userIds.entries()) {
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
      if (i === 0 && resumeConversation) {
        await context.addInitScript(
          ({ key, value }) => localStorage.setItem(key, value),
          {
            key: webConversationStorageKey(String(id), state.adoptIds[i]),
            value: resumeConversation,
          }
        );
      }
      page.on("pageerror", error => report.errors.push(error.message));
      await page.goto(`http://127.0.0.1:5173/claw/${state.adoptIds[i]}`);
      await page.locator("textarea.main-chat-input").last().waitFor();
      contexts.push(context);
      pages.push(page);
    }
    const [a, b] = pages;
    const [latest] = await db
      .select({ id: s.clawCollabRequests.id })
      .from(s.clawCollabRequests)
      .orderBy(desc(s.clawCollabRequests.id))
      .limit(1);
    const minRequest = Number(
      process.argv.find(arg => arg.startsWith("--min-request="))?.slice(14) ??
        latest?.id ??
        0
    );
    let conversationId = resumeConversation || "";
    if (!resumeConversation) {
      await a.getByRole("button", { name: "新建会话", exact: true }).click();
      await a.locator(".role-task-launchpad").waitFor();
      await a.waitForTimeout(500);
      const prompt = `帮我调整“${state.title}”。B在原定时间有冲突，请和日程演示用户B、日程验收用户C的助手协作，检查北京时间${state.date}的11:00–12:00、13:00–14:00、14:00–15:00三个候选时间，也检查我的日历。收齐结果后，在本对话告诉我共同可用时间并准备原会议的改期，等我确认再执行。保留原参与人，不要新建另一场会议。`;
      const sent = a.waitForRequest(
        r => r.method() === "POST" && r.url().endsWith("/api/claw/chat-stream")
      );
      await a.locator("textarea.main-chat-input").last().fill(prompt);
      await a.locator('button[title="发送"]').last().click();
      conversationId = (await sent).postDataJSON().conversationId;
      log("submitted", { conversationId, prompt });
    } else log("resumed-verification", { conversationId });
    const approved = new Set<number>();
    let confirmed = false,
      lastState = "";
    const deadline = Date.now() + 12 * 60000;
    while (Date.now() < deadline) {
      const allow = a
        .getByRole("button", { name: "本次允许", exact: true })
        .first();
      if (await allow.isVisible()) await allow.click();
      const requests = await db
        .select()
        .from(s.clawCollabRequests)
        .where(
          and(
            gt(s.clawCollabRequests.id, minRequest),
            eq(s.clawCollabRequests.requesterAdoptId, state.adoptIds[0])
          )
        );
      for (const request of requests) {
        if (
          request.targetAdoptId === state.adoptIds[1] &&
          request.status === "pending" &&
          !approved.has(request.id)
        ) {
          await b.reload();
          await b.locator("textarea.main-chat-input").last().waitFor();
          await b.getByText("工作区动态", { exact: true }).first().click();
          await b
            .locator(`[data-collaboration-request-id="${request.id}"]`)
            .getByRole("button", { name: "批准本次协作", exact: true })
            .click();
          approved.add(request.id);
          log("approved-by-B", { requestId: request.id });
        }
      }
      const runs = await db
        .select()
        .from(s.collaborationRuns)
        .where(eq(s.collaborationRuns.sourceConversationId, conversationId));
      const signature = JSON.stringify({
        requests: requests.map(r => ({
          id: r.id,
          target: r.targetAdoptId,
          status: r.status,
        })),
        runs: runs.map(r => ({
          id: r.id,
          status: r.status,
          turn: r.turn,
          message: r.publicMessage,
        })),
      });
      if (signature !== lastState) {
        log("progress", JSON.parse(signature));
        lastState = signature;
      }
      const confirm = a
        .getByRole("button", { name: "确认改期并更新原会议", exact: true })
        .first();
      if (!confirmed && (await confirm.isVisible())) {
        assert(
          requests.some(
            r =>
              r.targetAdoptId === state.adoptIds[1] && r.status === "completed"
          )
        );
        assert(
          requests.some(
            r =>
              r.targetAdoptId === state.adoptIds[2] && r.status === "completed"
          )
        );
        assert.deepEqual(
          await readCalendars(),
          before,
          "Calendars changed before owner confirmation"
        );
        const article = confirm.locator("xpath=ancestor::article[1]");
        const text = await article.textContent();
        assert(
          text?.includes("14:00") && text.includes("15:00"),
          "Wrong reschedule slot"
        );
        await a.screenshot({ path: "logs/multi-person-before-confirm.png" });
        await confirm.click();
        confirmed = true;
        log("confirmed-in-original-conversation", { text });
      }
      if (confirmed && runs.some(r => r.status === "completed")) {
        const after = await readCalendars();
        for (const [i, events] of after.entries()) {
          const meetings = events.filter(event => event.title === state.title);
          assert.equal(meetings.length, 1);
          assert.equal(
            meetings[0].id.split(":")[0],
            before[i].find(e => e.title === state.title)!.id.split(":")[0],
            "Original meeting UID must be preserved"
          );
          assert.equal(
            meetings[0].start,
            new Date(`${state.date}T14:00:00+08:00`).toISOString()
          );
          assert.equal(
            meetings[0].end,
            new Date(`${state.date}T15:00:00+08:00`).toISOString()
          );
          assert.deepEqual(
            meetings[0].participants,
            before[i].find(e => e.title === state.title)!.participants
          );
          assert.deepEqual(
            events.filter(e => e.title !== state.title),
            before[i].filter(e => e.title !== state.title)
          );
        }
        const sessionId = Object.entries(readSessionRegistry()).find(
          ([key]) =>
            key.startsWith(`${state.adoptIds[0]}:`) &&
            key.endsWith(`:web:${conversationId}`)
        )?.[1]?.sessionKey;
        const response = await contexts[0].request.get(
          `http://127.0.0.1:5174/api/claw/chat-history/messages?${new URLSearchParams({ adoptId: state.adoptIds[0], sessionKey: sessionId! })}`
        );
        const messages = (await response.json()).messages as {
          role?: string;
          text?: string;
          toolCalls?: { name: string }[];
        }[];
        assert.equal(
          messages.filter(m => m.role === "user").length,
          1,
          "Continuation required extra user input"
        );
        const done = runs.find(r => r.status === "completed")!;
        if (!messages.some(m => m.text === done.publicMessage)) {
          await a.waitForTimeout(1500);
          continue;
        }
        await a.reload();
        await a.locator("textarea.main-chat-input").last().waitFor();
        await a
          .getByText(done.publicMessage.split("\n")[0], { exact: false })
          .last()
          .waitFor();
        await a.screenshot({ path: "logs/multi-person-completed.png" });
        assert.deepEqual(report.errors, []);
        report.passed = true;
        report.after = after;
        report.finalMessage = done.publicMessage;
        log("passed", { userMessages: 1, confirmed, calendars: after.length });
        return;
      }
      if (runs.some(r => r.status === "failed"))
        throw new Error("Collaboration goal failed");
      await a.waitForTimeout(2000);
    }
    throw new Error(
      "Timed out waiting for collaboration/reschedule continuation"
    );
  } finally {
    await browser.close();
  }
}
main()
  .catch(error => {
    log("failed", { error: error.message });
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
