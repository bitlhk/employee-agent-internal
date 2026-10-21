import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { chromium } from "@playwright/test";
import * as s from "../drizzle/schema";
import { closeDbConnection } from "../server/db/connection";
import {
  localFixtureDatabase,
  createDemoAssistants,
  syncDemoAssistantAssets,
} from "./scheduling-e2e-fixture";
import { assertCollaborationRuntimeReady } from "../server/_core/collaboration/runtime-readiness";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";

// Persistent local demonstration, intentionally not an automated test run.
// No messages, approvals or calendar writes are performed for the operator.
const statePath = "data/scheduling-manual-demo.json";
const base = "http://127.0.0.1:5173";
const userIds = [2, 3];
async function main() {
  const db = await localFixtureDatabase();
  await assertCollaborationRuntimeReady();
  assert((await fetch("http://127.0.0.1:8088/status.php")).ok);
  const users = await db
    .select()
    .from(s.users)
    .where(inArray(s.users.id, userIds));
  let state: { prefix: string; spaceId: number; adoptIds: string[] };
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8"));
    assert(/^model-e2e-[0-9a-f]{8}$/.test(state.prefix));
    for (const [i, adoptId] of state.adoptIds.entries()) {
      const [owner] = await db
        .select()
        .from(s.clawAdoptions)
        .where(eq(s.clawAdoptions.adoptId, adoptId));
      assert(owner?.userId === userIds[i] && owner.status === "active");
    }
    console.log(
      JSON.stringify({
        assets: await syncDemoAssistantAssets(db, state.adoptIds),
      })
    );
  } else {
    const active = await db
      .select()
      .from(s.clawAdoptions)
      .where(
        and(
          inArray(s.clawAdoptions.userId, userIds),
          inArray(s.clawAdoptions.status, ["active", "expiring"])
        )
      );
    assert(
      active.length === 0,
      "Demo users already have active assistants; preserve them and inspect before preparing another environment"
    );
    const profiles = await db
      .select()
      .from(s.lxCollabUserProfiles)
      .where(inArray(s.lxCollabUserProfiles.userId, userIds));
    const bindings = await db
      .select({
        userId: s.calendarBindings.userId,
        autoAvailability: s.calendarBindings.autoAvailability,
        discoverable: s.calendarBindings.discoverable,
      })
      .from(s.calendarBindings)
      .where(inArray(s.calendarBindings.userId, userIds));
    assert(bindings.length === 2, "Demo calendars must already be provisioned");
    const prefix = `model-e2e-${randomUUID().slice(0, 8)}`;
    writeFileSync(
      "data/scheduling-manual-demo-backup.json",
      JSON.stringify({ prefix, profiles, bindings }, null, 2)
    );
    const [space] = await db
      .insert(s.lxCollabSpaces)
      .values({ name: "日程协作人工体验", status: "active" });
    await db
      .delete(s.lxCollabUserProfiles)
      .where(inArray(s.lxCollabUserProfiles.userId, userIds));
    await db.insert(s.lxCollabUserProfiles).values(
      userIds.map(userId => ({
        userId,
        spaceId: space.insertId,
        status: "active" as const,
        organizationName: "日程协作人工体验",
        teamName: "体验小组",
      }))
    );
    const assistants = await createDemoAssistants(db, userIds, prefix);
    await db
      .update(s.calendarBindings)
      .set({ autoAvailability: true, discoverable: false })
      .where(inArray(s.calendarBindings.userId, userIds));
    for (const [i, assistant] of assistants.entries()) {
      await db
        .update(s.clawCollabSettings)
        .set({
          displayName: `日程演示用户${"AB"[i]}的助手`,
          schedulingAcceptTask: "approval",
          schedulingSharingPolicy: "result-only",
        })
        .where(eq(s.clawCollabSettings.adoptionId, assistant.id));
    }
    state = {
      prefix,
      spaceId: space.insertId,
      adoptIds: assistants.map(a => a.adoptId),
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  if (process.argv.includes("--sync-only")) {
    await closeDbConnection();
    return;
  }
  const browsers = [];
  for (const [i, userId] of userIds.entries()) {
    const user = users.find(u => u.id === userId)!;
    const browser = await chromium.launch({
      channel: "msedge",
      headless: false,
      args: [
        `--window-position=${i * 100},${i * 60}`,
        "--window-size=1280,900",
      ],
    });
    const context = await browser.newContext({ viewport: null });
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
    await page.goto(`${base}/claw/${state.adoptIds[i]}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("textarea.main-chat-input")
      .last()
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.evaluate(label => {
      document.title = label;
    }, `日程体验 ${"AB"[i]} — ${user.name}`);
    browsers.push(browser);
    console.log(`READY ${"AB"[i]} ${base}/claw/${state.adoptIds[i]}`);
  }
  console.log(
    "Manual demo ready. Both windows are independent; no task has been sent. Demo data remains after closing windows."
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
main().catch(async error => {
  console.error(
    error instanceof Error ? error.message : "Manual demo setup failed"
  );
  await closeDbConnection();
  process.exitCode = 1;
});
