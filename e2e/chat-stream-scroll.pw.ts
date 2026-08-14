import { expect, test } from "@playwright/test";

const sessionToken = String(process.env.EA_E2E_SESSION_TOKEN || "").trim();
const adoptId = String(process.env.EA_E2E_ADOPT_ID || "").trim();
const cookieName = String(
  process.env.EA_E2E_SESSION_COOKIE
  || process.env.SESSION_COOKIE_NAME
  || "app_session_id",
).trim();

test.skip(!sessionToken || !adoptId, "EA_E2E_SESSION_TOKEN and EA_E2E_ADOPT_ID are required");

test("manual upward scrolling pauses streaming auto-follow", async ({ context, page, baseURL }) => {
  await context.addCookies([{
    name: cookieName,
    value: sessionToken,
    url: baseURL,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);

  await page.goto(`/claw/${encodeURIComponent(adoptId)}`, { waitUntil: "domcontentloaded" });
  const viewport = page.locator("[aria-busy]").first();
  await expect(viewport).toBeVisible();

  await viewport.evaluate((node) => {
    const content = node.firstElementChild;
    if (!content) throw new Error("chat content was not mounted");
    for (let index = 0; index < 90; index += 1) {
      const row = document.createElement("p");
      row.textContent = `stream regression seed ${index}`;
      row.style.height = "28px";
      content.appendChild(row);
    }
  });

  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(500);
  await viewport.hover();
  await page.mouse.wheel(0, -700);
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(200);
  const anchoredTop = await viewport.evaluate((node) => node.scrollTop);

  await viewport.evaluate(async (node) => {
    const content = node.firstElementChild;
    if (!content) throw new Error("chat content was not mounted");
    for (let index = 0; index < 20; index += 1) {
      const token = document.createElement("span");
      token.textContent = ` token-${index}`;
      token.style.display = "block";
      token.style.height = "18px";
      content.appendChild(token);
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
  });

  const afterStreamingTop = await viewport.evaluate((node) => node.scrollTop);
  expect(Math.abs(afterStreamingTop - anchoredTop)).toBeLessThanOrEqual(2);
  const returnButton = page.getByRole("button", { name: "回到底部" });
  await expect(returnButton).toBeVisible();
  await returnButton.click();
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(12);
});
