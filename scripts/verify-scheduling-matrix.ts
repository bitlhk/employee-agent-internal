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
import { goalAvailability } from "../server/_core/collaboration/progress";
import { getCalendarCredentials } from "../server/db/scheduling";
import { readOwnCalendar } from "../server/_core/scheduling/calendar";
import { webConversationStorageKey } from "../client/src/lib/chat-session-state";
import { releasedAvailability } from "../shared/scheduling-progress";
const report: {
  passed: boolean;
  phases: Record<string, unknown>[];
  errors: string[];
  [key: string]: unknown;
} = { passed: false, phases: [], errors: [] };
function log(phase: string, data: Record<string, unknown> = {}) {
  report.phases.push({ phase, ...data });
  writeFileSync(
    "logs/scheduling-matrix-e2e.json",
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify({ phase, ...data }));
}
async function main() {
  const db = await localFixtureDatabase();
  const state = JSON.parse(
    readFileSync("data/multi-person-calendar-demo.json", "utf8")
  );
  const calendar = () =>
    Promise.all(
      (state.userIds as number[]).map(async (id: number) =>
        readOwnCalendar(id, (await getCalendarCredentials(id))!, {
          start: `${state.date}T00:00:00+08:00`,
          end: `${state.date}T23:59:59+08:00`,
        })
      )
    );
  const before = await calendar();
  const resume = process.argv
    .find(arg => arg.startsWith("--conversation="))
    ?.slice(15);
  const browser = await chromium.launch({ headless: true });
  try {
    const pages = [],
      contexts = [];
    for (const [i, id] of state.userIds.entries()) {
      const [user] = await db.select().from(s.users).where(eq(s.users.id, id));
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
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
      if (i === 0 && resume)
        await context.addInitScript(
          ({ key, value }) => localStorage.setItem(key, value),
          {
            key: webConversationStorageKey(String(id), state.adoptIds[i]),
            value: resume,
          }
        );
      page.on("pageerror", error => report.errors.push(error.message));
      await page.goto(`http://127.0.0.1:5173/claw/${state.adoptIds[i]}`);
      await page.locator("textarea.main-chat-input").last().waitFor();
      contexts.push(context);
      pages.push(page);
    }
    const [a, b, c] = pages;
    const [latest] = await db
      .select({ id: s.clawCollabRequests.id })
      .from(s.clawCollabRequests)
      .orderBy(desc(s.clawCollabRequests.id))
      .limit(1);
    let conversationId = resume || "";
    const minRequest = Number(
      process.argv.find(arg => arg.startsWith("--min-request="))?.slice(14) ??
        latest?.id ??
        0
    );
    if (!resume) {
      await a.getByRole("button", { name: "新建会话", exact: true }).click();
      await a.locator(".role-task-launchpad").waitFor();
      await a.waitForTimeout(500);
      const sent = a.waitForRequest(
        r => r.method() === "POST" && r.url().endsWith("/api/claw/chat-stream")
      );
      await a
        .locator("textarea.main-chat-input")
        .last()
        .fill(
          `我想临时加一个三人讨论会，请帮我和日程演示用户B、日程验收用户C的助手协调北京时间${state.date}的11:00–12:00、13:00–14:00、15:00–16:00三个候选时段，也检查我的日历。请后台收齐回复后在原对话给出大家都方便的方案，这次只给方案，不创建或修改日历。`
        );
      await a.locator('button[title="发送"]').last().click();
      conversationId = (await sent).postDataJSON().conversationId;
    }
    log("submitted", { conversationId });
    let approved = Boolean(resume),
      last = "";
    for (const deadline = Date.now() + 600000; Date.now() < deadline; ) {
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
      const [run] = await db
        .select()
        .from(s.collaborationRuns)
        .where(eq(s.collaborationRuns.sourceConversationId, conversationId));
      const signature = JSON.stringify({
        status: run?.status,
        turn: run?.turn,
        requests: requests.map(r => ({ id: r.id, status: r.status })),
      });
      if (signature !== last) {
        log("progress", JSON.parse(signature));
        last = signature;
      }
      const requestB = requests.find(
        r => r.targetAdoptId === state.adoptIds[1]
      );
      if (requestB?.status === "pending" && !approved) {
        await b.reload();
        await b.getByText("工作区动态", { exact: true }).first().click();
        const card = b.locator(
          `[data-collaboration-request-id="${requestB.id}"]`
        );
        await card
          .getByRole("button", { name: "批准本次协作", exact: true })
          .waitFor();
        await card.getByText("批准本次协作", { exact: true }).waitFor();
        if (await card.locator("table").count())
          throw new Error("接收方请求卡片不应展示忙闲矩阵");
        await b.screenshot({ path: "logs/matrix-recipient-pending.png" });
        await card
          .getByRole("button", { name: "批准本次协作", exact: true })
          .click();
        approved = true;
      }
      if (run?.status === "failed")
        throw new Error(run.publicMessage || "Goal failed");
      if (run?.status === "completed") {
        assert(approved);
        assert.equal(requests.length, 2);
        const matrix = await goalAvailability(2, state.adoptIds[0], run.id);
        assert.equal(matrix.people.length, 3);
        assert.equal(matrix.rows.length, 3);
        const expired = requests.every(request => {
          const result = releasedAvailability(request.resultSummary || "");
          return result && Date.parse(result.validUntil) <= Date.now();
        });
        if (resume && expired) {
          assert.equal(matrix.rows.filter(row => row.common).length, 0);
          assert(
            matrix.rows.every(row =>
              row.cells.slice(1).every(cell => cell === "expired")
            )
          );
        } else {
          assert.equal(matrix.rows.filter(row => row.common).length, 1);
          assert.equal(
            new Date(matrix.rows.find(row => row.common)!.start).getUTCHours(),
            7
          );
          assert(matrix.rows.some(row => row.cells.includes("busy")));
        }
        const final = run
          .publicMessage!.split("\n")
          .find(line => line.trim())!
          .replace(/[*_`#]/g, "")
          .trim();
        await a
          .getByText(final, { exact: false })
          .last()
          .waitFor({ timeout: 60000 });
        const cards = a.locator('[aria-label="本会话协作办理进度"]');
        await cards.waitFor();
        assert.equal(await cards.count(), 1);
        const region = cards.getByRole("region", { name: "参与人忙闲矩阵" });
        await region.waitFor();
        assert.equal(await region.locator("thead th").count(), 4);
        assert.equal(await region.locator("tbody tr").count(), 3);
        assert.equal(
          await cards
            .getByRole("button", { name: "查看日历", exact: true })
            .count(),
          0
        );
        await cards.screenshot({ path: "logs/matrix-requester.png" });
        for (const [i, page] of [
          [1, b],
          [2, c],
        ] as const) {
          const req = requests.find(
            r => r.targetAdoptId === state.adoptIds[i]
          )!;
          await page.reload();
          await page.getByText("工作区动态", { exact: true }).first().click();
          const card = page.locator(
            `[data-collaboration-request-id="${req.id}"]`
          );
          await card
            .getByText("助手已完成本次询问。发起方助手会根据结果继续回复。", {
              exact: true,
            })
            .waitFor();
          assert.equal(await card.count(), 1);
          await card.getByText("本次回复", { exact: true }).waitFor();
          assert.equal(await card.locator("table").count(), 0);
          assert.equal(
            await card
              .getByText("未保存可展示的回复内容。", { exact: true })
              .count(),
            0
          );
          await card.screenshot({ path: `logs/matrix-recipient-${i}.png` });
        }
        const sessionKey = Object.entries(readSessionRegistry()).find(
          ([key]) =>
            key.startsWith(state.adoptIds[0] + ":") &&
            key.endsWith(":web:" + conversationId)
        )?.[1]?.sessionKey;
        const response = await contexts[0].request.get(
          "http://127.0.0.1:5174/api/claw/chat-history/messages?" +
            new URLSearchParams({
              adoptId: state.adoptIds[0],
              sessionKey: sessionKey!,
            })
        );
        const messages = (await response.json()).messages as {
          role?: string;
          text?: string;
          toolCalls?: { name: string }[];
        }[];
        // Manual follow-ups may exist when inspecting an old demonstration.
        if (!resume) assert.equal(messages.filter(m => m.role === "user").length, 1);
        assert.equal(
          messages.filter(m =>
            m.toolCalls?.some(t => t.name === "ea_conversation_update")
          ).length,
          1,
          "Intermediate progress must not append chat messages"
        );
        assert.deepEqual(await calendar(), before);
        assert.deepEqual(report.errors, []);
        report.passed = true;
        report.matrix = matrix;
        log("passed", { runId: run.id, calendarUnchanged: true });
        return;
      }
      await a.waitForTimeout(2000);
    }
    throw new Error("Matrix workflow timed out");
  } finally {
    await browser.close();
  }
}
main()
  .catch(error => {
    log("failed", { error: error.message, stack: error.stack });
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
