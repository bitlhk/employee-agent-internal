import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync, openSync, closeSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { closeDbConnection } from "../server/db/connection";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";
import { assertCollaborationRuntimeReady } from "../server/_core/collaboration/runtime-readiness";
import {
  localFixtureDatabase,
  createDemoAssistants,
  cleanupDemoScenario,
  ownerRpc,
} from "./scheduling-e2e-fixture";
import { getCalendarCredentials } from "../server/db/scheduling";
import { readOwnCalendar } from "../server/_core/scheduling/calendar";
import { schedulingConfirmations } from "../client/src/lib/scheduling-confirmations";
import { readSessionRegistry } from "../server/_core/helpers";

// Real browser, model, managed workers, owner decisions and provider calendar.
// No model mocks, injected replies, direct publisher ticks or forced success states.
const base =
  process.env.WORKFORCE_AGENT_INTERNAL_BASE_URL || "http://127.0.0.1:5174";
const uiBase = process.env.SCHEDULING_E2E_UI_URL || "http://127.0.0.1:5173";
const reportPath = "logs/scheduling-conversation-e2e-report.json";
const observations: Array<Record<string, unknown>> = [];
const streamErrors: string[] = [];
const streams = new WeakMap<Page, Promise<void>>();
let resettingConnection = false;
const isContextMessage = (row: { toolCalls?: Array<{ name: string }> }) =>
  row.toolCalls?.some(tool => tool.name === "ea_conversation_update") === true;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let prefix = "";
const log = (phase: string, data: Record<string, unknown> = {}) => {
  const item = { at: new Date().toISOString(), phase, ...data };
  observations.push(item);
  writeFileSync(reportPath, JSON.stringify({ prefix, observations }, null, 2));
  console.log(JSON.stringify(item));
};
async function until<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 180_000
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  while (Date.now() < deadline) {
    if (streamErrors.length) throw new Error(streamErrors[0]);
    value = await read();
    if (accept(value)) return value;
    if (
      value &&
      typeof value === "object" &&
      "status" in value &&
      ["failed", "cancelled", "waiting_input"].includes(String(value.status))
    )
      throw new Error(`${label}: status=${value.status}`);
    await pause(1500);
  }
  throw new Error(`Timeout: ${label}`);
}
async function sessions(context: BrowserContext, adoptId: string) {
  const response = await context.request.get(
    `${base}/api/claw/chat-history/sessions?adoptId=${adoptId}&limit=50`
  );
  assert(response.ok(), `sessions HTTP ${response.status()}`);
  const data = await response.json();
  return (data.sessions || []) as Array<{
    conversationId: string;
    sessionKey: string;
    title: string;
  }>;
}
async function history(
  context: BrowserContext,
  adoptId: string,
  sessionKey: string
) {
  const response = await context.request.get(
    `${base}/api/claw/chat-history/messages?adoptId=${adoptId}&sessionKey=${encodeURIComponent(sessionKey)}`
  );
  assert(response.ok(), `history HTTP ${response.status()}`);
  const data = await response.json();
  return data.messages as Array<{
    id: string;
    text: string;
    toolCalls?: Array<{ name: string; status: string; result?: string }>;
  }>;
}
async function send(page: Page, message: string) {
  const input = page.locator("textarea.main-chat-input").last();
  await input.waitFor({ state: "visible", timeout: 45_000 });
  await input.fill(message);
  const sent = page.waitForResponse(
    response =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/claw/chat-stream"),
    { timeout: 30_000 }
  );
  await page.locator('button[title="发送"]').last().click();
  const response = await sent;
  if (!response.ok())
    throw new Error(
      `Chat rejected (HTTP ${response.status()}): ${(await response.text()).slice(0, 500)}`
    );
  // Keep the browser available to answer an in-stream permission prompt.
  // Waiting for the whole response here would deadlock that owner decision.
  const done = response
    .text()
    .then(stream => {
      for (const line of stream.split("\n")) {
        if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
        let frame: {
          __stream_error?: boolean;
          message?: string;
          error?: string;
        };
        try {
          frame = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (frame.__stream_error)
          throw new Error(
            `Chat runtime failed: ${frame.message || frame.error || "stream error"}`
          );
      }
    })
    .catch(error => {
      if (!resettingConnection) streamErrors.push(error.message);
    });
  streams.set(page, done);
}
async function restartServices() {
  for (const port of [5174, 18092]) {
    const pid = Number(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`,
        ],
        { encoding: "utf8", windowsHide: true }
      ).trim()
    );
    assert(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    process.kill(pid);
  }
  await pause(1500);
  const launches = [
    {
      command: "C:/ProgramData/EmployeeAgent/jiuwen-runtime/Scripts/python.exe",
      args: [
        "-m",
        "jiuwenswarm.server.app_agentserver",
        "--dotenv",
        "C:/ProgramData/EmployeeAgent/jiuwen-data/config/.env",
        "--port",
        "18092",
      ],
      cwd: "C:/ProgramData/EmployeeAgent/jiuwen-data",
      name: "runtime",
    },
    {
      command: process.execPath,
      args: ["--env-file=.env", "--import", "tsx", "server/_core/index.ts"],
      cwd: process.cwd(),
      name: "backend",
    },
  ];
  for (const service of launches) {
    const out = openSync(
      `logs/calendar-${service.name}-restarted.stdout.log`,
      "a"
    );
    const err = openSync(
      `logs/calendar-${service.name}-restarted.stderr.log`,
      "a"
    );
    // Keep configured secrets in environment/config files, never argv or reports.
    const child = spawn(service.command, service.args, {
      cwd: service.cwd,
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err],
    });
    child.unref();
    closeSync(out);
    closeSync(err);
  }
  await until(
    "services restart and report live conversation capability",
    async () => {
      try {
        await assertCollaborationRuntimeReady();
        return (await fetch(`${base}/api/brand`)).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    120_000
  );
}
async function openSession(
  page: Page,
  context: BrowserContext,
  adoptId: string,
  conversationId: string
) {
  const records = await sessions(context, adoptId);
  const session = records.find(row => row.conversationId === conversationId);
  assert(session, `Missing ${conversationId} conversation`);
  const target = page.getByText(session.title, { exact: true }).first();
  await target.waitFor({ state: "visible", timeout: 45_000 });
  await target.click();
  return session;
}
async function main() {
  const db = await localFixtureDatabase();
  assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
  await until(
    "live runtime readiness",
    async () => {
      try {
        await assertCollaborationRuntimeReady();
        return true;
      } catch {
        return false;
      }
    },
    Boolean,
    120_000
  );
  const { listSelectableJiuwenModels } = await import(
    "../server/_core/jiuwenswarm-model-admin"
  );
  assert(
    (await listSelectableJiuwenModels()).length > 0,
    "Configured gateway model catalog must be ready"
  );
  const provider = await fetch(`${process.env.NEXTCLOUD_BASE_URL}/status.php`);
  assert(
    provider.ok,
    "Local calendar provider must be ready before fixtures are created"
  );
  prefix = `model-e2e-${randomUUID().slice(0, 8)}`;
  const userIds = [2, 3];
  const users = await db
    .select()
    .from(s.users)
    .where(inArray(s.users.id, userIds));
  const oldProfiles = await db
    .select()
    .from(s.lxCollabUserProfiles)
    .where(inArray(s.lxCollabUserProfiles.userId, userIds));
  const oldAdoptions = await db
    .select()
    .from(s.clawAdoptions)
    .where(
      and(
        inArray(s.clawAdoptions.userId, userIds),
        inArray(s.clawAdoptions.status, ["active", "expiring"])
      )
    );
  const oldBindings = await db
    .select()
    .from(s.calendarBindings)
    .where(inArray(s.calendarBindings.userId, userIds));
  const backupPath = `data/${prefix}-conversation-backup.json`;
  writeFileSync(
    backupPath,
    JSON.stringify({
      profiles: oldProfiles,
      adoptionStatuses: oldAdoptions.map(row => ({
        id: row.id,
        status: row.status,
      })),
      bindings: oldBindings.map(row => ({
        userId: row.userId,
        autoAvailability: row.autoAvailability,
        discoverable: row.discoverable,
      })),
    })
  );
  let spaceId: number | undefined;
  let adoptIds: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let success = false;
  const drafts: string[] = [];
  try {
    const [space] = await db
      .insert(s.lxCollabSpaces)
      .values({ name: prefix, status: "active" });
    spaceId = space.insertId;
    await db
      .delete(s.lxCollabUserProfiles)
      .where(inArray(s.lxCollabUserProfiles.userId, userIds));
    await db
      .insert(s.lxCollabUserProfiles)
      .values(
        userIds.map(userId => ({ userId, spaceId, status: "active" as const }))
      );
    if (oldAdoptions.length)
      await db
        .update(s.clawAdoptions)
        .set({ status: "failed" })
        .where(
          inArray(
            s.clawAdoptions.id,
            oldAdoptions.map(row => row.id)
          )
        );
    const assistants = await createDemoAssistants(db, userIds, prefix);
    adoptIds = assistants.map(row => row.adoptId);
    await db
      .update(s.calendarBindings)
      .set({ autoAvailability: true, discoverable: false })
      .where(inArray(s.calendarBindings.userId, userIds));
    await db
      .update(s.clawCollabSettings)
      .set({
        schedulingAcceptTask: "approval",
        schedulingSharingPolicy: "result-only",
      })
      .where(eq(s.clawCollabSettings.adoptionId, assistants[1].id));
    browser = await chromium.launch({ headless: true });
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];
    const pageErrors: string[] = [];
    for (const [index, userId] of userIds.entries()) {
      const user = users.find(row => row.id === userId)!;
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
          url: base,
        },
      ]);
      const page = await context.newPage();
      page.on("pageerror", error => pageErrors.push(error.message));
      await page.goto(`${uiBase}/claw/${adoptIds[index]}`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .locator("textarea.main-chat-input")
        .last()
        .waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForTimeout(1500);
      contexts.push(context);
      pages.push(page);
    }
    log("browser-ready", { prefix, adoptIds });
    const date = new Date(Date.now() + 32 * 86400000)
      .toISOString()
      .slice(0, 10);
    const start = `${date}T10:00:00+08:00`,
      end = `${date}T10:30:00+08:00`;
    await send(
      pages[0],
      `请帮我安排一场会议：我（日程演示用户A）与组织内的日程演示用户B，北京时间${date}10:00到10:30，标题${prefix}，地点本地验收。先按姓名找B，通过scheduling协作请求询问这个时间是否有空，并等待对方答复。B答复有空后直接准备会议草稿，不再另外发起忙闲查询；由我在当前对话点击确认后才能创建。请使用日程协同能力保存这个目标并后台续办。`
    );
    const goal = await until(
      "conversation creates durable goal",
      async () => {
        const rows = await db
          .select()
          .from(s.collaborationRuns)
          .where(eq(s.collaborationRuns.adoptId, adoptIds[0]));
        const text = await pages[0].locator("body").innerText();
        if (/CSRF request rejected|运行服务连接失败|会话处理失败/.test(text))
          throw new Error(text.slice(-1500));
        const approval = pages[0]
          .getByRole("button", { name: "本次允许", exact: true })
          .first();
        if (await approval.isVisible().catch(() => false))
          await approval.click();
        return rows.find(row => row.kind === "goal");
      },
      Boolean,
      240_000
    );
    assert(
      goal?.sourceSessionId &&
        Object.entries(readSessionRegistry()).some(
          ([key, value]) =>
            key.startsWith(`${adoptIds[0]}:`) &&
            value.sessionKey === goal.sourceSessionId
        ),
      "Goal must originate from a real registered conversation"
    );
    log("goal-created-from-chat", {
      goalId: goal.id,
      sourceConversationId: goal.sourceConversationId,
    });
    const request = await until(
      "pending organization request",
      async () =>
        (
          await db
            .select()
            .from(s.clawCollabRequests)
            .where(eq(s.clawCollabRequests.requesterAdoptId, adoptIds[0]))
        )[0],
      row => row?.status === "pending",
      240_000
    );
    assert.equal(request.targetAdoptId, adoptIds[1]);
    const inbox = await until(
      "proactive request creates workspace conversation",
      () => sessions(contexts[1], adoptIds[1]),
      rows => rows.some(row => row.conversationId === "calendar"),
      90_000
    );
    assert(inbox.some(row => row.conversationId === "calendar"));
    await openSession(pages[1], contexts[1], adoptIds[1], "calendar");
    const approve = pages[1]
      .getByRole("button", { name: "批准本次协作", exact: true })
      .first();
    await approve.waitFor({ state: "visible", timeout: 90_000 });
    await pages[1].screenshot({
      path: "logs/scheduling-conversation-request.png",
      fullPage: true,
    });
    if (process.argv.includes("--restart-services")) {
      resettingConnection = true;
      await pages[0].goto("about:blank");
      await streams.get(pages[0]);
      log("restart-checkpoint", { requestId: request.id });
      await restartServices();
      await pages[0].goto(`${uiBase}/claw/${adoptIds[0]}`, {
        waitUntil: "domcontentloaded",
      });
      resettingConnection = false;
      log("services-restarted-with-pending-request");
    }
    await pages[1].reload({ waitUntil: "domcontentloaded" });
    await approve.waitFor({ state: "visible", timeout: 45_000 });
    await approve.click();
    log("recipient-approved-in-chat", {
      requestId: request.id,
      restoredAfterReload: true,
    });
    const completed = await until(
      "real recipient queries calendar and replies",
      async () =>
        (
          await db
            .select()
            .from(s.clawCollabRequests)
            .where(eq(s.clawCollabRequests.id, request.id))
        )[0],
      row => row.status === "completed",
      240_000
    );
    assert(completed.resultSummary?.includes("available"));
    log("real-model-reply", { status: completed.status });
    const meeting = await until(
      "model resumes and prepares direct meeting",
      async () => {
        const rows = await db
          .select()
          .from(s.calendarMeetings)
          .where(eq(s.calendarMeetings.creatorUserId, 2));
        return rows.find(
          row =>
            (row.payload as { event?: { title?: string } })?.event?.title ===
            prefix
        );
      },
      row => row?.status === "pending",
      240_000
    );
    assert(
      meeting && meeting.coordinationId === null,
      "Direct meeting must not require a coordination record"
    );
    const sourceHistory = await until(
      "confirmation pushed into original conversation",
      () => history(contexts[0], adoptIds[0], goal.sourceSessionId!),
      rows =>
        rows.some(row =>
          schedulingConfirmations(row.toolCalls || []).some(
            action => action.kind === "meeting" && action.id === meeting.id
          )
        ),
      90_000
    );
    assert(sourceHistory.some(row => isContextMessage(row)));
    const confirm = pages[0]
      .getByRole("button", { name: "确认创建", exact: true })
      .first();
    await confirm.waitFor({ state: "visible", timeout: 90_000 });
    await confirm.scrollIntoViewIfNeeded();
    const credentials = (await getCalendarCredentials(2))!;
    assert(
      !(await readOwnCalendar(2, credentials, { start, end })).some(
        event => event.title === prefix
      ),
      "Draft must not write before user confirms"
    );
    await pages[0].screenshot({
      path: "logs/scheduling-conversation-confirm.png",
      fullPage: true,
    });
    await pages[0].reload({ waitUntil: "domcontentloaded" });
    await confirm.waitFor({ state: "visible", timeout: 45_000 });
    await ownerRpc(3, "confirmMeeting", { meetingId: meeting.id }, true);
    await confirm.click();
    log("owner-confirmed-in-chat", { meetingId: meeting.id });
    const finishedGoal = await until(
      "calendar write and autonomous goal completion",
      async () =>
        (
          await db
            .select()
            .from(s.collaborationRuns)
            .where(eq(s.collaborationRuns.id, goal.id))
        )[0],
      row => row.status === "completed",
      240_000
    );
    const own = (await readOwnCalendar(2, credentials, { start, end })).filter(
      event => event.title === prefix
    );
    assert.equal(own.length, 1);
    const peer = await readOwnCalendar(3, (await getCalendarCredentials(3))!, {
      start,
      end,
    });
    assert(peer.some(event => event.title === prefix && !event.canEdit));
    const finalMessages = await until(
      "completion proactively persisted",
      () => history(contexts[0], adoptIds[0], goal.sourceSessionId!),
      rows =>
        rows.some(
          row =>
            isContextMessage(row) &&
            row.text === finishedGoal.publicMessage &&
            !schedulingConfirmations(row.toolCalls || []).some(
              action => action.kind === "meeting"
            )
        ),
      90_000
    );
    const deliveryIds = finalMessages
      .filter(row => isContextMessage(row))
      .flatMap(row =>
        row
          .toolCalls!.filter(tool => tool.name === "ea_conversation_update")
          .map(tool => (tool as { id?: string }).id)
      );
    assert.equal(new Set(deliveryIds).size, deliveryIds.length);
    await ownerRpc(2, "confirmMeeting", { meetingId: meeting.id });
    assert.equal(
      (await readOwnCalendar(2, credentials, { start, end })).filter(
        event => event.title === prefix
      ).length,
      1
    );
    log("calendar-and-goal-completed", {
      persistedMessages: deliveryIds.length,
      duplicateEvents: false,
    });
    // A normal personal event close enough for the real reminder worker, not a
    // synthetic notification or a direct call to the publisher.
    const reminderStart = new Date(Date.now() + 8 * 60_000).toISOString();
    const reminderEnd = new Date(Date.now() + 12 * 60_000).toISOString();
    const reminderTitle = `${prefix}-主动提醒`;
    const draft = (await ownerRpc(2, "prepareWrite", {
      action: "create",
      operationId: randomUUID(),
      event: {
        title: reminderTitle,
        location: "本地提醒验收",
        time: { type: "timed", start: reminderStart, end: reminderEnd },
      },
    })) as { draftId: string };
    drafts.push(draft.draftId);
    await ownerRpc(2, "confirmWrite", { draftId: draft.draftId });
    const reminderSession = (
      await until(
        "automatic upcoming-event push",
        () => sessions(contexts[0], adoptIds[0]),
        rows => rows.some(row => row.conversationId === "calendar"),
        100_000
      )
    ).find(row => row.conversationId === "calendar")!;
    await until(
      "reminder persisted in real history",
      () => history(contexts[0], adoptIds[0], reminderSession.sessionKey),
      rows => rows.some(row => row.text.includes(reminderTitle)),
      90_000
    );
    await openSession(pages[0], contexts[0], adoptIds[0], "calendar");
    await pages[0]
      .getByText(`日程提醒：${reminderTitle}`, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 45_000 });
    await pages[0].screenshot({
      path: "logs/scheduling-conversation-reminder.png",
      fullPage: true,
    });
    await send(
      pages[0],
      "只根据当前对话里已经收到的提醒，告诉我那个日程的完整标题，不要查询日历或调用其他工具。"
    );
    await until(
      "warm model reads persisted proactive context",
      () => history(contexts[0], adoptIds[0], reminderSession.sessionKey),
      rows =>
        rows.some(
          row => !isContextMessage(row) && row.text.includes(reminderTitle)
        ),
      150_000
    );
    log("proactive-reminder-and-model-context", {
      reminderSession: reminderSession.sessionKey,
    });
    await pause(12_000);
    const reminderMessages = await history(
      contexts[0],
      adoptIds[0],
      reminderSession.sessionKey
    );
    assert.equal(
      reminderMessages.filter(
        row => isContextMessage(row) && row.text.includes(reminderTitle)
      ).length,
      1
    );
    assert.deepEqual(pageErrors, []);
    success = true;
    log("passed", {
      checks: [
        "real-browser-chat",
        "same-org-search",
        "recipient-approval-restored",
        "real-model-collaboration",
        "automatic-resume",
        "direct-meeting-no-coordination",
        "original-conversation-confirmation",
        "no-write-before-confirmation",
        "owner-boundary",
        "provider-participant-sync",
        "deduplicated-retry",
        "persistent-proactive-reminder",
        "model-context",
      ],
    });
  } finally {
    if (!success && browser) {
      for (const [i, context] of browser.contexts().entries())
        for (const page of context.pages())
          await page
            .screenshot({
              path: `logs/scheduling-conversation-failed-${i}.png`,
              fullPage: true,
            })
            .catch(() => undefined);
    }
    await browser?.close();
    // Remove only this scenario's known calendar events, then its DB records.
    for (const userId of drafts.length ? userIds : []) {
      const credentials = await getCalendarCredentials(userId);
      if (!credentials) continue;
      const now = new Date().toISOString(),
        later = new Date(Date.now() + 86400000).toISOString();
      for (const event of await readOwnCalendar(userId, credentials, {
        start: now,
        end: later,
      }))
        if (
          event.title.startsWith(prefix) &&
          event.resourceId &&
          event.version
        ) {
          const draft = (await ownerRpc(userId, "prepareWrite", {
            action: "delete",
            resourceId: event.resourceId,
            version: event.version,
            title: event.title,
          })) as { draftId: string };
          drafts.push(draft.draftId);
          await ownerRpc(userId, "confirmWrite", { draftId: draft.draftId });
        }
    }
    await cleanupDemoScenario(db, prefix, adoptIds, userIds);
    if (drafts.length)
      await db
        .delete(s.calendarWriteDrafts)
        .where(inArray(s.calendarWriteDrafts.id, drafts));
    await db
      .delete(s.lxCollabUserProfiles)
      .where(inArray(s.lxCollabUserProfiles.userId, userIds));
    if (oldProfiles.length)
      await db.insert(s.lxCollabUserProfiles).values(oldProfiles);
    if (spaceId)
      await db.delete(s.lxCollabSpaces).where(eq(s.lxCollabSpaces.id, spaceId));
    for (const row of oldAdoptions)
      await db
        .update(s.clawAdoptions)
        .set({ status: row.status })
        .where(eq(s.clawAdoptions.id, row.id));
    for (const row of oldBindings)
      await db
        .update(s.calendarBindings)
        .set({
          autoAvailability: row.autoAvailability,
          discoverable: row.discoverable,
        })
        .where(eq(s.calendarBindings.userId, row.userId));
    log("cleaned", { succeeded: success });
  }
}
main()
  .catch(error => {
    log("failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
