import "dotenv/config";

import { chromium, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { COOKIE_NAME } from "../shared/const";
import { getUserByEmail } from "../server/db/users";
import { closeDbConnection } from "../server/db/connection";
import { sdk, sessionAuthVersion } from "../server/_core/sdk";

const root = process.cwd();
const baseUrl = process.env.SMART_AUDIT_BROWSER_BASE_URL || "https://work.linggan.top";
const userEmail = String(process.env.SMART_AUDIT_BROWSER_USER_EMAIL || "").trim();
const adoptId = String(process.env.SMART_AUDIT_BROWSER_ADOPT_ID || "").trim();
const timeoutMs = Number(process.env.SMART_AUDIT_BROWSER_TIMEOUT_MS || 360_000);
const outputPath = path.resolve(
  process.env.SMART_AUDIT_BROWSER_REPORT_PATH
    || "reports/smart-audit/browser-e2e-report.json",
);
const fixtureRoot = path.join(root, "examples", "smart-audit-reference-role-pack", "demo-case");
const fixtureFiles = [
  "01-贷款申请表.md",
  "02-主体身份证明.md",
  "03-银行流水摘要.md",
  "04-财务报表摘要.md",
  "05-设备采购合同.md",
].map((file) => path.join(fixtureRoot, file));

const reviewPrompt = [
  "请使用智能审核岗位助手审核我上传的 CASE-AU-20260826-001 演示材料。",
  "必须调用确定性工具检查材料完整性、核验现行规则版本并执行人工复核分级。",
  "当前任务只能采用 V2.0 现行规则，明确排除 V1.0 历史规则。",
  "请列出跨材料冲突、材料编号和人工复核等级；本轮只生成复核任务草稿，不要执行最终审批或写入。",
].join("");
const confirmationPrompt = "我确认按刚才完全相同的案件和疑点创建演示人工复核任务。";

function required(value: string, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function waitForAssistantTurn(page: Page, baselineCount: number) {
  const messages = page.locator(".lingxia-ai-bubble-wrap");
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const count = await messages.count();
    if (count <= baselineCount) continue;
    text = await messages.last().innerText().catch(() => "");
    const stop = page.getByTitle("停止生成");
    const streaming = (await stop.count()) > 0 && await stop.first().isVisible().catch(() => false);
    const permission = page.getByRole("button", { name: "本次允许" });
    if (!streaming && (text.trim().length > 0 || await permission.count() > 0)) {
      return { text, count };
    }
  }
  throw new Error(`smart-audit browser turn timed out after ${timeoutMs}ms`);
}

async function browserEvidence(page: Page) {
  return page.evaluate(() => {
    const assistants: Array<Record<string, unknown>> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.includes("messages")) continue;
      try {
        const messages = JSON.parse(window.localStorage.getItem(key) || "[]");
        if (!Array.isArray(messages)) continue;
        for (const raw of messages) {
          if (!raw || typeof raw !== "object" || raw.role !== "assistant") continue;
          assistants.push({
            id: raw.id,
            text: String(raw.text || "").slice(0, 20_000),
            toolCalls: Array.isArray(raw.toolCalls)
              ? raw.toolCalls.map((tool: Record<string, unknown>) => ({
                  name: tool.name,
                  status: tool.status,
                  result: String(tool.result || "").slice(0, 20_000),
                }))
              : [],
            receiptBundle: raw.receiptBundle || null,
          });
        }
      } catch {
        // Ignore unrelated malformed local cache entries.
      }
    }
    return assistants.slice(-8);
  });
}

async function main() {
  required(userEmail, "SMART_AUDIT_BROWSER_USER_EMAIL");
  required(adoptId, "SMART_AUDIT_BROWSER_ADOPT_ID");
  const user = await getUserByEmail(userEmail);
  if (!user) throw new Error(`verification user does not exist: ${userEmail}`);
  const token = await sdk.signSession({
    userId: user.id,
    name: user.name || userEmail.split("@")[0],
    authVersion: sessionAuthVersion(user),
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: COOKIE_NAME, value: token, url: baseUrl }]);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) pageErrors.push(`HTTP ${response.status()} ${response.url()}`);
  });

  await page.goto(`${baseUrl}/claw/${adoptId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  if (await page.getByText("无权访问该工作台", { exact: true }).count()) {
    throw new Error(`${userEmail} cannot access ${adoptId}`);
  }
  const composer = page.locator("textarea.main-chat-input").last();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  const fileInput = page.locator('input[type="file"][multiple][accept*=".md"]').last();
  await fileInput.setInputFiles(fixtureFiles);
  const assistantMessages = page.locator(".lingxia-ai-bubble-wrap");
  const firstBaseline = await assistantMessages.count();
  await composer.fill(reviewPrompt);
  await composer.press("Enter");
  const first = await waitForAssistantTurn(page, firstBaseline);
  const firstEvidence = await browserEvidence(page);
  const firstSerialized = JSON.stringify(firstEvidence);
  const readChecks = {
    noRuntimeTimeout: !/runtime_timeout|响应较慢|处理超时/u.test(`${first.text}\n${firstSerialized}`),
    currentRuleV2: /V2\.0/u.test(`${first.text}\n${firstSerialized}`),
    historicalRuleExcluded: /V1\.0/u.test(`${first.text}\n${firstSerialized}`) && /排除|历史|失效/u.test(first.text),
    materialPolicyCalled: /evaluate_audit_required_materials/u.test(firstSerialized),
    ruleEligibilityCalled: /evaluate_audit_rule_eligibility/u.test(firstSerialized),
    humanReviewCalled: /evaluate_audit_human_review/u.test(firstSerialized),
    l4Review: /L4/u.test(`${first.text}\n${firstSerialized}`),
  };

  const secondBaseline = await assistantMessages.count();
  await composer.fill(confirmationPrompt);
  await composer.press("Enter");
  await page.getByRole("button", { name: "本次允许" }).waitFor({ state: "visible", timeout: timeoutMs });
  await page.getByRole("button", { name: "本次允许" }).click();
  const second = await waitForAssistantTurn(page, secondBaseline);
  await page.waitForTimeout(3_000);
  const finalEvidence = await browserEvidence(page);
  const finalSerialized = JSON.stringify(finalEvidence);
  const writeChecks = {
    reviewTaskToolCalled: /demo_create_audit_review_task/u.test(finalSerialized),
    executionReceiptPresent: /receiptBundle|execution_receipt|Business Receipt|业务回执/u.test(finalSerialized),
    noRuntimeTimeout: !/runtime_timeout|响应较慢|处理超时/u.test(`${second.text}\n${finalSerialized}`),
  };
  const checks = { ...readChecks, ...Object.fromEntries(Object.entries(writeChecks).map(([key, value]) => [`write_${key}`, value])) };
  const status = Object.values(checks).every(Boolean) && pageErrors.length === 0 ? "PASS" : "FAIL";
  const report = {
    schema: "ea.smart-audit-browser-e2e.v1",
    status,
    baseUrl,
    adoptId,
    userEmail,
    caseId: "CASE-AU-20260826-001",
    fixtureFiles: fixtureFiles.map((file) => path.basename(file)),
    checkedAt: new Date().toISOString(),
    checks,
    pageErrors,
    firstResponse: first.text.slice(0, 20_000),
    secondResponse: second.text.slice(0, 20_000),
    evidence: finalEvidence,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  if (status !== "PASS") process.exitCode = 1;
}

main()
  .finally(() => closeDbConnection())
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
