import { expect, test, type Page } from "@playwright/test";

const sessionToken = String(process.env.EA_E2E_SESSION_TOKEN || "").trim();
const adoptId = String(process.env.EA_E2E_ADOPT_ID || "lgj-lihongkun").trim();
const cookieName = String(process.env.EA_E2E_SESSION_COOKIE || "app_session_id").trim();
const cookieValue = sessionToken.startsWith(`${cookieName}=`)
  ? sessionToken.slice(cookieName.length + 1)
  : sessionToken;

test.skip(!sessionToken, "EA_E2E_SESSION_TOKEN is required");
test.setTimeout(8 * 60_000);

async function openFreshConversation(page: Page, baseURL: string | undefined): Promise<void> {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await page.goto(`${baseURL}/claw/${encodeURIComponent(adoptId)}`, { waitUntil: "domcontentloaded" });
  await page.locator("textarea.main-chat-input").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "新建会话" }).click({ timeout: 30_000 });
  await expect(page.locator("textarea.main-chat-input")).toBeVisible();
  await page.waitForTimeout(1_000);
}

async function sendAndWait(page: Page, prompt: string): Promise<string> {
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/claw/chat-stream")
    && response.request().method() === "POST"
  ), { timeout: 60_000 });
  await page.locator("textarea.main-chat-input").fill(prompt);
  await page.getByTitle("发送").click();
  const response = await responsePromise;
  await response.finished();
  return response.text();
}

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{
    name: cookieName,
    value: cookieValue,
    url: baseURL,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
});

test("governed demo write requires approval and succeeds after confirmation", async ({ page, baseURL }) => {
  await openFreshConversation(page, baseURL);
  const unique = `hook-e2e-${Date.now()}`;
  const initialStream = await sendAndWait(page, [
    "请现在调用企业跟进任务写入工具创建一条隔离 Demo 任务，不要只生成草稿。",
    "客户标识：陈明（Demo）/ C005。",
    "目标：2026-08-26 10:00 前补齐到期持仓明细并准备正式配置方案。",
    "截止时间：2026-08-26T10:00:00+08:00；优先级：high。",
    `幂等键：${unique}。`,
    "平台若要求正式操作确认，请发起确认卡；不要把本条自然语言当作平台审批。",
  ].join("\n"));

  expect(initialStream).not.toContain("运行时尚未证明治理挂钩有效");
  const allowButton = page.getByRole("button", { name: "本次允许" });
  for (let attempt = 0; attempt < 3 && !(await allowButton.isVisible().catch(() => false)); attempt += 1) {
    const businessConfirmation = page.getByRole("radiogroup").getByRole("radio").first();
    const hasStructuredConfirmation = await businessConfirmation.isVisible().catch(() => false);
    if (hasStructuredConfirmation) {
      await businessConfirmation.check();
    } else {
      await page.locator("textarea.main-chat-input").fill(
        "确认创建。请立即使用上一轮完全相同的业务参数和 idempotency_key 调用企业跟进任务写入工具；平台正式审批仍按系统门禁执行。",
      );
    }
    const toolCallResponse = page.waitForResponse((response) => (
      response.url().endsWith(hasStructuredConfirmation
        ? "/api/claw/jiuwen/permission-answer"
        : "/api/claw/chat-stream")
      && response.request().method() === "POST"
    ), { timeout: 60_000 });
    await page.getByRole("button", { name: "发送" }).click();
    const response = await toolCallResponse;
    await response.finished();
    await page.waitForTimeout(1_000);
  }
  await expect(allowButton).toBeVisible({ timeout: 120_000 });

  const resumedResponse = page.waitForResponse((response) => (
    response.url().endsWith("/api/claw/chat-stream")
    && response.request().method() === "POST"
  ), { timeout: 60_000 });
  await allowButton.click();
  const response = await resumedResponse;
  await response.finished();

  await expect(page.locator(".lingxia-ai-bubble-wrap").last()).toContainText(/已创建|记录编号/u, {
    timeout: 120_000,
  });
  const finalText = await page.locator(".lingxia-ai-bubble-wrap").last().innerText();
  expect(finalText).toMatch(/DEMO-FOLLOWUP|客户跟进任务已创建/u);
  expect(finalText).not.toContain("运行时尚未证明治理挂钩有效");
  console.log(JSON.stringify({ scenario: "governed-demo-write", idempotencyKey: unique, approved: true }));
});
