import "dotenv/config";

import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { COOKIE_NAME } from "@shared/const";
import { getUserByEmail } from "../server/db/users";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";

const baseUrl =
  process.env.DEMO_BROWSER_BASE_URL || "http://111.119.236.165:5180";
const hostResolverRules =
  process.env.DEMO_BROWSER_HOST_RESOLVER_RULES ||
  "MAP 111.119.236.165 127.0.0.1";
const userEmail = process.env.DEMO_BROWSER_USER_EMAIL || "test2@example.com";
const adoptId = process.env.DEMO_BROWSER_ADOPT_ID || "lgj-mjrsrqkp";
const outputPath = resolve(
  process.env.DEMO_BROWSER_REPORT_PATH ||
    "reports/demo-enterprise-assets/wealth-agent-v33-aligned-report.json"
);
const prompt =
  process.env.DEMO_BROWSER_PROMPT ||
  "请核验当前财富产品适当性销售制度，并明确告诉我采用的制度版本、生效时间和已排除的旧版本。";

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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies([{ name: COOKIE_NAME, value: token, url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [];
  const toolResultFrames: string[] = [];
  const sseDiagnostics: Array<Record<string, unknown>> = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.status() >= 500)
      errors.push(`HTTP ${response.status()} ${response.url()}`);
    if (!response.url().includes("/api/claw/chat")) return;
    void response
      .finished()
      .then(() => response.text())
      .then(raw => {
        const events = raw
          .split("\n")
          .filter(line => line.startsWith("event: "))
          .map(line => line.slice(7).trim());
        sseDiagnostics.push({
          url: response.url(),
          status: response.status(),
          eventCount: events.length,
          events: Array.from(new Set(events)),
          hasResponseEvidence: raw.includes("__context_response_evidence"),
          hasContextReceipt: raw.includes("eaContextReceipt"),
          hasToolResult: events.includes("tool_result"),
          doneCount: raw.split("data: [DONE]").length - 1,
        });
      })
      .catch(error => {
        sseDiagnostics.push({
          url: response.url(),
          status: response.status(),
          readError: String(error?.message || error),
        });
      });
  });
  page.on("websocket", socket => {
    socket.on("framereceived", event => {
      const payload =
        typeof event.payload === "string"
          ? event.payload
          : event.payload.toString("utf8");
      if (
        !payload.includes("tool_result") &&
        !payload.includes("eaContextReceipt")
      )
        return;
      toolResultFrames.push(payload.slice(0, 120_000));
    });
  });

  const startedAt = Date.now();
  await page.goto(`${baseUrl}/claw/${adoptId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2_000);

  const body = page.locator("body");
  const accessDenied = await body
    .getByText("无权访问该工作台", { exact: true })
    .count();
  if (accessDenied) throw new Error(`${userEmail} cannot access ${adoptId}`);

  const composer = page.locator("textarea").last();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.fill(prompt);
  await composer.press("Enter");

  const expectedVersion = /V3\.3/i;
  const oldVersion = /V2\.2/i;
  let excerpt = "";
  let finished = false;
  const deadline =
    Date.now() + Number(process.env.DEMO_BROWSER_TIMEOUT_MS || 180_000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    excerpt = await body.innerText();
    const hasExpectedVersion = expectedVersion.test(excerpt);
    const hasCompletionSignal =
      excerpt.includes("处理完成") || excerpt.includes("内容由 AI 生成");
    if (hasExpectedVersion && hasCompletionSignal) {
      finished = true;
      break;
    }
  }

  if (finished) {
    // Streaming decorations can keep changing after the answer is complete.
    // Give late tool-result events a bounded window instead of requiring the
    // entire page text to become byte-for-byte stable.
    await page.waitForTimeout(6_000);
    excerpt = await body.innerText();
  }

  const currentRun = excerpt.slice(excerpt.lastIndexOf(prompt));
  const browserMessageDiagnostics = await page.evaluate(() => {
    const diagnostics: Array<Record<string, unknown>> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.includes("messages")) continue;
      try {
        const messages = JSON.parse(window.localStorage.getItem(key) || "[]");
        if (!Array.isArray(messages)) continue;
        for (const message of messages.slice(-4)) {
          if (message?.role !== "assistant") continue;
          diagnostics.push({
            storageKey: key,
            messageId: message?.id,
            hasReceiptBundle: Boolean(message?.receiptBundle),
            receiptStages: Array.isArray(message?.receiptBundle?.stages)
              ? message.receiptBundle.stages.map((stage: any) => ({
                  taskId: stage?.taskId,
                  receiptId: stage?.receiptId,
                }))
              : [],
            toolCalls: Array.isArray(message?.toolCalls)
              ? message.toolCalls.map((tool: any) => ({
                  id: tool?.id,
                  name: tool?.name,
                  status: tool?.status,
                  hasResult: Boolean(tool?.result),
                  resultHasReceipt:
                    typeof tool?.result === "string" &&
                    tool.result.includes("eaContextReceipt"),
                }))
              : [],
          });
        }
      } catch {
        // Ignore unrelated local-storage values.
      }
    }
    return diagnostics;
  });
  const receiptButton = page.getByRole("button", { name: /本次依据/ }).last();
  const receiptVisible = (await receiptButton.count()) > 0;
  let receiptText = "";
  if (receiptVisible) {
    await receiptButton.click();
    await page.waitForTimeout(500);
    receiptText = await body.innerText();
    receiptText = receiptText.slice(
      receiptText.lastIndexOf("本次依据"),
      receiptText.lastIndexOf("本次依据") + 4_000
    );
  }
  const receiptVersionPresent = /(?:V?3\.3|版本\s*3\.3)/i.test(receiptText);
  const receiptEffectiveAtPresent =
    /(?:生效|effective)/i.test(receiptText) &&
    /(?:2026[-年/])?0?8[-月/]2[01]/i.test(receiptText);
  const receiptExclusionPresent = /(?:排除|过滤|失效|替代|历史版本)/i.test(
    receiptText
  );
  const result = {
    schema: "ea.demo-browser-context-verification.v1",
    status:
      finished &&
      expectedVersion.test(currentRun) &&
      receiptVisible &&
      receiptVersionPresent &&
      receiptEffectiveAtPresent &&
      receiptExclusionPresent
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
    receiptVersionPresent,
    receiptEffectiveAtPresent,
    receiptExclusionPresent,
    receiptText,
    browserMessageDiagnostics,
    sseDiagnostics,
    toolResultFrames,
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

  console.log(
    JSON.stringify(
      {
        status: result.status,
        finished: result.finished,
        expectedVersionPresent: result.expectedVersionPresent,
        historicalVersionMentioned: result.historicalVersionMentioned,
        receiptVisible: result.receiptVisible,
        receiptVersionPresent: result.receiptVersionPresent,
        receiptEffectiveAtPresent: result.receiptEffectiveAtPresent,
        receiptExclusionPresent: result.receiptExclusionPresent,
        elapsedMs: result.elapsedMs,
        errors: result.errors,
        outputPath,
      },
      null,
      2
    )
  );

  if (result.status !== "PASS") process.exitCode = 1;
}

await main();
