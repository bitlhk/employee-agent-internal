import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { chromium } from "@playwright/test";
import * as s from "../drizzle/schema";
import {
  localFixtureDatabase,
  ensureThirdDemoUser,
  createDemoAssistants,
  syncDemoAssistantAssets,
} from "./scheduling-e2e-fixture";
import { closeDbConnection } from "../server/db/connection";
import { getCalendarCredentials } from "../server/db/scheduling";
import { readOwnCalendar } from "../server/_core/scheduling/calendar";
import {
  prepareCalendarWrite,
  confirmCalendarWrite,
} from "../server/_core/scheduling/write-service";
import {
  prepareDirectMeeting,
  confirmMeeting,
} from "../server/_core/scheduling/meeting-service";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";

// Persistent manual fixture: seed only; leave collaboration and rescheduling to the operator.
async function main() {
  const db = await localFixtureDatabase();
  const original = JSON.parse(
    readFileSync("data/scheduling-manual-demo.json", "utf8")
  ) as { spaceId: number; adoptIds: string[] };
  const c = await ensureThirdDemoUser(db);
  const [profile] = await db
    .select()
    .from(s.lxCollabUserProfiles)
    .where(eq(s.lxCollabUserProfiles.userId, c));
  if (profile) {
    await db
      .update(s.lxCollabUserProfiles)
      .set({
        spaceId: original.spaceId,
        status: "active",
        organizationName: "日程协作人工体验",
        teamName: "体验小组",
      })
      .where(eq(s.lxCollabUserProfiles.userId, c));
  } else {
    await db
      .insert(s.lxCollabUserProfiles)
      .values({
        userId: c,
        spaceId: original.spaceId,
        status: "active",
        organizationName: "日程协作人工体验",
        teamName: "体验小组",
      });
  }
  let [assistant] = await db
    .select()
    .from(s.clawAdoptions)
    .where(
      and(eq(s.clawAdoptions.userId, c), eq(s.clawAdoptions.status, "active"))
    );
  if (!assistant) {
    [assistant] = await createDemoAssistants(
      db,
      [c],
      `model-e2e-${randomUUID().slice(0, 8)}`
    );
  } else {
    await syncDemoAssistantAssets(db, [assistant.adoptId]);
  }
  await db
    .update(s.clawCollabSettings)
    .set({
      displayName: "日程验收用户C的助手",
      schedulingAcceptTask: "auto",
      schedulingSharingPolicy: "result-only",
    })
    .where(eq(s.clawCollabSettings.adoptionId, assistant.id));
  await db
    .update(s.calendarBindings)
    .set({ autoAvailability: true })
    .where(eq(s.calendarBindings.userId, c));
  const scenarioDate = process.argv.find(arg => arg.startsWith("--date="))?.slice(7);
  if (scenarioDate) assert(/^\d{4}-\d{2}-\d{2}$/.test(scenarioDate) && Date.parse(`${scenarioDate}T10:00:00+08:00`) > Date.now(), "Use a future date for a separate manual scenario");
  const statePath = scenarioDate ? `data/multi-person-calendar-demo-${scenarioDate}.json` : "data/multi-person-calendar-demo.json";
  type State = {
    date: string;
    title: string;
    requestKey: string;
    operations: string[];
    userIds: number[];
    adoptIds: string[];
    meetingId?: string;
  };
  const state: State = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {
        date: scenarioDate || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        title: `三人改期演示-${randomUUID().slice(0, 6)}`,
        requestKey: randomUUID(),
        operations: [randomUUID(), randomUUID(), randomUUID()],
        userIds: [2, 3, c],
        adoptIds: [...original.adoptIds, assistant.adoptId],
      };
  assert.deepEqual(state.userIds, [2, 3, c]);
  assert(state.adoptIds[2] === assistant.adoptId);
  await syncDemoAssistantAssets(db, original.adoptIds);
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
  save();
  const event = (title: string, hour: number) => ({
    title,
    location: "本地人工演示",
    time: {
      type: "timed" as const,
      start: `${state.date}T${hour}:00:00+08:00`,
      end: `${state.date}T${hour + 1}:00:00+08:00`,
    },
  });
  const blockers = [
    { userId: 3, hour: 10, name: "B客户沟通" },
    { userId: c, hour: 11, name: "C培训" },
    { userId: 2, hour: 13, name: "A项目评审" },
  ];
  for (const [i, blocker] of blockers.entries()) {
    const draft = await prepareCalendarWrite(blocker.userId, {
      action: "create",
      event: event(`${state.title}-${blocker.name}`, blocker.hour),
      operationId: state.operations[i],
    });
    await confirmCalendarWrite(blocker.userId, draft.draftId);
  }
  if (!state.meetingId) {
    const meeting = await prepareDirectMeeting(2, {
      requestKey: state.requestKey,
      event: event(state.title, 10),
      participantIds: [3, c],
    });
    state.meetingId = meeting.meetingId;
    save();
  }
  await confirmMeeting(2, state.meetingId);
  const calendars = [];
  for (const userId of state.userIds) {
    const credentials = await getCalendarCredentials(userId);
    assert(credentials);
    const events = await readOwnCalendar(userId, credentials, {
      start: `${state.date}T00:00:00+08:00`,
      end: `${state.date}T23:59:59+08:00`,
    });
    const blocker = blockers.find(item => item.userId === userId)!;
    assert(
      events.some(item => item.title === `${state.title}-${blocker.name}`),
      "Seeded conflict missing from calendar"
    );
    const freeStart = Date.parse(`${state.date}T14:00:00+08:00`);
    assert(
      !events.some(
        item =>
          item.busy &&
          Date.parse(item.start) < freeStart + 3600000 &&
          Date.parse(item.end) > freeStart
      ),
      "Expected shared slot has another event; inspect before using demo"
    );
    calendars.push({
      userId,
      events: events.map(item => ({
        title: item.title,
        start: item.start,
        end: item.end,
        participants: item.participants,
      })),
    });
  }
  writeFileSync(
    scenarioDate ? `logs/multi-person-calendar-demo-${scenarioDate}.json` : "logs/multi-person-calendar-demo.json",
    JSON.stringify(
      { state, calendars, checkedAt: new Date().toISOString() },
      null,
      2
    )
  );
  console.log(JSON.stringify({ ready: true, ...state }));
  if (process.argv.includes("--open")) {
    const browsers = [];
    for (const [i, userId] of state.userIds.entries()) {
      const [user] = await db
        .select()
        .from(s.users)
        .where(eq(s.users.id, userId));
      const browser = await chromium.launch({
        channel: "msedge",
        headless: false,
        args: [
          `--window-position=${i * 80},${i * 50}`,
          "--window-size=1280,900",
        ],
      });
      const context = await browser.newContext({ viewport: null });
      context.setDefaultTimeout(45000);
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
      await page.goto(`http://127.0.0.1:5173/claw/${state.adoptIds[i]}`);
      await page
        .locator("textarea.main-chat-input")
        .last()
        .waitFor({ state: "visible", timeout: 60000 });
      if (scenarioDate && i === 0) {
        await page.getByRole("button", { name: "新建会话", exact: true }).click();
        await page.locator(".role-task-launchpad").waitFor();
        await page.waitForTimeout(500);
        await page.locator("textarea.main-chat-input").last().fill(`北京时间${state.date}的「${state.title}」有时间冲突，帮我和日程演示用户B、日程验收用户C协调当天11:00–12:00、13:00–14:00或14:00–15:00，检查大家的忙闲，给出方案并准备原会议改期，等我确认后执行。`);
      } else if (scenarioDate) {
        await page.getByText("工作区动态", { exact: true }).first().click();
      }
      await page.evaluate(name => {
        document.title = `三人改期体验 — ${name}`;
      }, user.name);
      browsers.push(browser);
    }
    console.log(
      "WINDOWS_READY: A, B, C. No conversation sent or reschedule confirmed."
    );
    await closeDbConnection();
    await Promise.all(
      browsers.map(
        browser =>
          new Promise<void>(resolve =>
            browser.once("disconnected", () => resolve())
          )
      )
    );
  }
}
main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : "Demo failed");
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
