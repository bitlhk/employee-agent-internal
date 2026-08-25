import { expect, test, type Page } from "@playwright/test";

const sessionToken = String(process.env.EA_E2E_SESSION_TOKEN || "").trim();
const adoptId = String(process.env.EA_E2E_ADOPT_ID || "lgj-lihongkun").trim();
const cookieName = String(process.env.EA_E2E_SESSION_COOKIE || "app_session_id").trim();

test.skip(!sessionToken, "EA_E2E_SESSION_TOKEN is required");
test.setTimeout(8 * 60_000);

async function openFreshConversation(page: Page, baseURL: string | undefined): Promise<void> {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await page.goto(`${baseURL}/claw/${encodeURIComponent(adoptId)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("textarea.main-chat-input").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "新建会话" }).click({ timeout: 30_000 });
  await expect(page.locator("textarea.main-chat-input")).toBeVisible();
  await page.waitForTimeout(1_000);
}

async function submitAndWait(page: Page, prompt: string): Promise<{
  responseText: string;
  streamText: string;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const composer = page.locator("textarea.main-chat-input");
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/claw/chat-stream")
    && response.request().method() === "POST"
  ), { timeout: 60_000 });
  await composer.fill(prompt);
  await page.getByTitle("发送").click();
  const response = await responsePromise;
  await response.finished();
  const streamText = await response.text();
  const responseText = page.locator(".lingxia-ai-bubble-wrap").last();
  await expect(responseText).toBeVisible({ timeout: 30_000 });
  return {
    responseText: await responseText.innerText(),
    streamText,
    durationMs: Date.now() - startedAt,
  };
}

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{
    name: cookieName,
    value: sessionToken,
    url: baseURL,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
});

test("C005 renders a durable artifact card and eligible product candidates", async ({ page, baseURL }) => {
  await openFreshConversation(page, baseURL);
  const result = await submitAndWait(page,
    "请使用客户经理财富助手技能，为陈明（C005）准备明天下午的访前简报。必须核验客户画像、风险测评有效期、持仓、到期资产、当前可售产品和现行制度；在合规允许时给出产品配置候选及排除项，并生成一份可下载的 Markdown 访前材料文件。",
  );

  expect(result.responseText).toMatch(/陈明|C005/u);
  expect(result.responseText).toMatch(/P002|P004|稳健增利|固收/u);
  expect(result.responseText).not.toMatch(/风险测评(?:已|已经).{0,12}(?:过期|失效)/u);
  expect(result.streamText).toContain("event: workspace_files");
  const artifact = page.locator('.lingxia-message-attachments[aria-label="生成的附件"]').last();
  await expect(artifact).toBeVisible({ timeout: 30_000 });
  await expect(artifact).toContainText(/陈明|访前|简报/u);
  await expect(artifact.getByTitle("下载")).toBeVisible();
  console.log(JSON.stringify({ scenario: "C005", durationMs: result.durationMs, artifact: true }));
});

test("C003 remains blocked from formal recommendation", async ({ page, baseURL }) => {
  await openFreshConversation(page, baseURL);
  const result = await submitAndWait(page,
    "请使用客户经理财富助手技能，核验王强（C003）是否可以形成正式产品推荐。必须检查风险测评有效期和当前可售产品；不满足条件时明确阻断，不得给出正式产品推荐，并说明需要补齐什么。",
  );

  expect(result.responseText).toMatch(/王强|C003/u);
  expect(result.responseText).toMatch(/过期|失效|阻断|不能|不得|暂不/u);
  expect(result.responseText).not.toMatch(/正式推荐(?:方案)?[：:]\s*(?:P002|P004)/u);
  console.log(JSON.stringify({ scenario: "C003", durationMs: result.durationMs, blocked: true }));
});
