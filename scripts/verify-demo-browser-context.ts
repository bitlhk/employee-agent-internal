import "dotenv/config";

import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { COOKIE_NAME } from "@shared/const";
import { getUserByEmail } from "../server/db/users";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";

const baseUrl = process.env.DEMO_BROWSER_BASE_URL || "http://111.119.236.165:5180";
const hostResolverRules = process.env.DEMO_BROWSER_HOST_RESOLVER_RULES
  || "MAP 111.119.236.165 127.0.0.1";
const userEmail = process.env.DEMO_BROWSER_USER_EMAIL || "test2@example.com";
const adoptId = process.env.DEMO_BROWSER_ADOPT_ID || "lgj-mjrsrqkp";
const outputPath = resolve(
  process.env.DEMO_BROWSER_REPORT_PATH
    || "reports/demo-enterprise-assets/wealth-agent-v33-aligned-report.json",
);
const prompt = process.env.DEMO_BROWSER_PROMPT
  || "请核验当前财富产品适当性销售制度，并明确告诉我采用的制度版本、生效时间和已排除的旧版本。";

async function main() {
  const user = await getUserByEmail(userEmail);
  if (!user) throw new Error(`verification user does not exist: ${userEmail}`);

  const token = await sdk.signSession({
    userId: user.id,
    name: user.name || userEmail.split("@")[0],
    authVersion: sessionAuthVersion(user),
  });

  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=${hostResolverRules}`],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: COOKIE_NAME, value: token, url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${response.url()}`);
  });

  const startedAt = Date.now();
  await page.goto(`${baseUrl}/claw/${adoptId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);

  const body = page.locator("body");
  const accessDenied = await body.getByText("无权访问该工作台", { exact: true }).count();
  if (accessDenied) throw new Error(`${userEmail} cannot access ${adoptId}`);

  const composer = page.locator("textarea").last();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.fill(prompt);
  await composer.press("Enter");

  const expectedVersion = /V3\.3/i;
  const oldVersion = /V2\.2/i;
  let excerpt = "";
  let finished = false;
  const deadline = Date.now() + Number(process.env.DEMO_BROWSER_TIMEOUT_MS || 180_000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    excerpt = await body.innerText();
    const hasExpectedVersion = expectedVersion.test(excerpt);
    const hasCompletionSignal = excerpt.includes("处理完成") || excerpt.includes("内容由 AI 生成");
    if (hasExpectedVersion && hasCompletionSignal) {
      finished = true;
      break;
    }
  }

  if (finished) {
    let previous = excerpt;
    for (let stableChecks = 0; stableChecks < 3;) {
      await page.waitForTimeout(2_000);
      excerpt = await body.innerText();
      if (excerpt === previous) stableChecks += 1;
      else stableChecks = 0;
      previous = excerpt;
    }
  }

  const currentRun = excerpt.slice(excerpt.lastIndexOf(prompt));
  const receiptVisible = await page.getByRole("button", { name: /本次依据/ }).count() > 0;
  const result = {
    schema: "ea.demo-browser-context-verification.v1",
    status: finished && expectedVersion.test(currentRun) && receiptVisible
      ? "PASS"
      : "FAIL",
    baseUrl,
    adoptId,
    prompt,
    finished,
    elapsedMs: Date.now() - startedAt,
    expectedVersionPresent: expectedVersion.test(currentRun),
    historicalVersionMentioned: oldVersion.test(currentRun),
    receiptVisible,
    excerpt: currentRun.slice(-8_000),
    errors,
    timestamp: new Date().toISOString(),
  };

  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await page.screenshot({
    path: outputPath.replace(/\.json$/i, ".png"),
    fullPage: true,
  });
  await browser.close();

  console.log(JSON.stringify({
    status: result.status,
    finished: result.finished,
    expectedVersionPresent: result.expectedVersionPresent,
    historicalVersionMentioned: result.historicalVersionMentioned,
    receiptVisible: result.receiptVisible,
    elapsedMs: result.elapsedMs,
    errors: result.errors,
    outputPath,
  }, null, 2));

  if (result.status !== "PASS") process.exitCode = 1;
}

await main();
