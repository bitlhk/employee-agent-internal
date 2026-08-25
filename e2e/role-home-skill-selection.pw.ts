import { expect, test } from "@playwright/test";

const sessionToken = String(process.env.EA_E2E_SESSION_TOKEN || "").trim();
const adoptId = String(process.env.EA_E2E_ADOPT_ID || "lgj-lihongkun").trim();
const skillLabel = String(process.env.EA_E2E_SKILL_LABEL || "客户经理财富助手").trim();
const cookieName = String(process.env.EA_E2E_SESSION_COOKIE || "app_session_id").trim();
const cookieValue = sessionToken.startsWith(`${cookieName}=`)
  ? sessionToken.slice(cookieName.length + 1)
  : sessionToken;

test.skip(!sessionToken, "EA_E2E_SESSION_TOKEN is required");

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

test("welcome page can select the role default skill", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const failures: Array<{ status: number; url: string; body: string }> = [];
  const readinessResponses: Array<{ status: number; url: string; body: string }> = [];
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("probeSkillReadiness")) {
      void response.text()
        .then((body) => readinessResponses.push({ status: response.status(), url: response.url(), body: body.slice(0, 4_000) }))
        .catch(() => readinessResponses.push({ status: response.status(), url: response.url(), body: "<unreadable>" }));
    }
    if (response.status() < 400) return;
    void response.text()
      .then((body) => failures.push({ status: response.status(), url: response.url(), body: body.slice(0, 2_000) }))
      .catch(() => failures.push({ status: response.status(), url: response.url(), body: "<unreadable>" }));
  });

  await page.goto(`${baseURL}/claw/${encodeURIComponent(adoptId)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("textarea.main-chat-input")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.waitForTimeout(1_500);

  const skill = page.locator(".role-task-launchpad__skill", { hasText: skillLabel });
  await expect(skill).toBeVisible({ timeout: 30_000 });
  const selectedBefore = await skill.getAttribute("data-selected");
  await skill.click();
  await page.waitForTimeout(1_000);

  const selected = await skill.getAttribute("data-selected");
  const visibleErrors = await page.locator('[data-sonner-toast], [role="alert"]')
    .allInnerTexts()
    .catch(() => []);
  console.log(JSON.stringify({ selectedBefore, selected, visibleErrors, readinessResponses, failures, consoleErrors }, null, 2));

  expect(visibleErrors).toEqual([]);
  expect(failures).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expect(skill).toHaveAttribute("data-selected", "true");
});
