import "dotenv/config";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { localFixtureDatabase } from "./scheduling-e2e-fixture";
import { closeDbConnection } from "../server/db/connection";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";
import { COOKIE_NAME } from "../shared/const";

// Read existing completed replies without sending requests or modifying calendars.
async function main() {
  const requestIds = process.argv
    .find(arg => arg.startsWith("--request-ids="))
    ?.slice(14)
    .split(",")
    .map(Number);
  assert(
    requestIds?.length &&
      requestIds.every(id => Number.isSafeInteger(id) && id > 0),
    "Provide --request-ids=<completed request IDs>"
  );
  const db = await localFixtureDatabase();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const requestId of requestIds) {
      const [request] = await db
        .select()
        .from(s.clawCollabRequests)
        .where(eq(s.clawCollabRequests.id, requestId));
      assert(request, `Request ${requestId} not found`);
      assert.equal(request.status, "completed");
      const [user] = await db
        .select()
        .from(s.users)
        .where(eq(s.users.id, request.targetUserId));
      const context = await browser.newContext();
      await context.addCookies([
        {
          name: COOKIE_NAME,
          value: await sdk.signSession({
            userId: user.id,
            name: user.name!,
            authVersion: sessionAuthVersion(user),
          }),
          url: "http://127.0.0.1:5173",
        },
      ]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:5173/claw/${request.targetAdoptId}`);
      await page.getByText("工作区动态", { exact: true }).first().click();
      const card = page.locator(
        `[data-collaboration-request-id="${requestId}"]`
      );
      await card.getByText("本次回复", { exact: true }).waitFor();
      assert.equal(await card.locator("table").count(), 0);
      assert.equal(
        await card
          .getByText("未保存可展示的回复内容。", { exact: true })
          .count(),
        0
      );
      const details = card.getByText("查看回复时的忙闲", { exact: true });
      if (await details.count()) await details.click();
      assert((await card.innerText()).includes("本次回复时的结论"));
      assert.deepEqual(errors, []);
      await card.screenshot({ path: `logs/reply-card-${requestId}.png` });
      console.log(JSON.stringify({ requestId, passed: true }));
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
