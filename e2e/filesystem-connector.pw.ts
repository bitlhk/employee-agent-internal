import "dotenv/config";
import { expect, test, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import { and, desc, eq } from "drizzle-orm";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  enterpriseAssetCandidates,
  enterpriseAssetSourceItems,
  enterpriseAssetSourceRuns,
  enterpriseAssetSources,
  users,
} from "../drizzle/schema";
import { closeDbConnection, getDb } from "../server/db/connection";

const suffix = `${Date.now()}-${process.pid}`;
const sourceId = `e2e-fs-${suffix}`;
const sourceName = `E2E 财富制度源 ${suffix}`;
const email = `connector-e2e-${suffix}@local.test`;
const password = `Connector-${suffix}!`;
const sourceRoot = path.join(process.cwd(), "data", "enterprise-connectors", sourceId);
const stagingRoot = path.join(process.cwd(), "data", "e2e-enterprise-asset-candidates");

function document(index: number, revision = 0): string {
  return [
    `# 演示银行财富管理制度 ${String(index).padStart(2, "0")} V1.0`,
    "",
    "适用部门：财富管理部",
    "适用岗位：财富经理",
    `当前内容修订：${revision}`,
    "本制度用于验证企业资产持续同步、治理和审核。",
    "",
  ].join("\n");
}

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Connector browser E2E requires DATABASE_URL");
  return db;
}

async function cleanup(): Promise<void> {
  const db = await database();
  await db.delete(enterpriseAssetCandidates).where(eq(enterpriseAssetCandidates.sourceId, sourceId));
  await db.delete(enterpriseAssetSourceItems).where(eq(enterpriseAssetSourceItems.sourceId, sourceId));
  await db.delete(enterpriseAssetSourceRuns).where(eq(enterpriseAssetSourceRuns.sourceId, sourceId));
  await db.delete(enterpriseAssetSources).where(eq(enterpriseAssetSources.sourceId, sourceId));
  await db.delete(users).where(eq(users.email, email));
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
}

async function prepareInitialDocuments(): Promise<void> {
  await mkdir(sourceRoot, { recursive: true });
  for (let index = 1; index <= 10; index += 1) {
    await writeFile(path.join(sourceRoot, `wealth-policy-${String(index).padStart(2, "0")}-V1.0.md`), document(index));
  }
}

async function login(page: Page): Promise<void> {
  await page.goto("/login?redirect=%2Fadmin");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function selectSource(page: Page, triggerLabel: string): Promise<void> {
  await page.getByRole("combobox", { name: triggerLabel }).click();
  await page.getByRole("option", { name: sourceName, exact: true }).click();
}

async function expectSyncResult(page: Page, expected: { created: number; changed: number; skipped: number; tombstones: number }): Promise<void> {
  await expect(page.getByText(`同步完成：新增 ${expected.created}，变化 ${expected.changed}，未变化 ${expected.skipped}，删除候选 ${expected.tombstones}`)).toBeVisible();
  const operations = page.getByTestId("source-operations");
  await expect(operations.getByTestId("source-run-新增")).toContainText(String(expected.created));
  await expect(operations.getByTestId("source-run-变化")).toContainText(String(expected.changed));
  await expect(operations.getByTestId("source-run-跳过")).toContainText(String(expected.skipped));
  await expect(operations.getByTestId("source-run-删除候选")).toContainText(String(expected.tombstones));
}

async function syncAndExpect(page: Page, expected: { created: number; changed: number; skipped: number; tombstones: number }): Promise<void> {
  await page.getByTestId("sync-selected-source").click();
  await expectSyncResult(page, expected);
}

test.beforeAll(async () => {
  await cleanup();
  const db = await database();
  await db.insert(users).values({
    name: "Connector E2E Admin",
    email,
    password: await bcrypt.hash(password, 10),
    loginMethod: "email",
    role: "admin",
    accessLevel: "all",
    lastSignedIn: new Date(),
  });
  await prepareInitialDocuments();
});

test.afterAll(async () => {
  await cleanup();
  await closeDbConnection();
});

test("administrator can operate the filesystem connector lifecycle", async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole("tab", { name: /岗位资产接入/ }).click();
  await expect(page.getByRole("heading", { name: "企业资产接入与整改" })).toBeVisible();

  await page.getByRole("button", { name: "登记来源" }).click();
  const sourceDialog = page.getByRole("dialog", { name: "登记企业资产来源" });
  const sourceInputs = sourceDialog.locator("input");
  await sourceInputs.nth(0).fill(sourceId);
  await sourceInputs.nth(1).fill(sourceName);
  await sourceInputs.nth(2).fill("财富管理部");
  await sourceInputs.nth(3).fill(pathToFileURL(sourceRoot).href);
  await sourceDialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("接入来源已保存")).toBeVisible();

  await selectSource(page, "选择来源同步状态");
  await rm(sourceRoot, { recursive: true, force: true });
  await page.getByTestId("sync-selected-source").click();
  await expect(page.getByTestId("source-operations").getByText("失败原因：", { exact: false })).toBeVisible();
  await expect(page.getByTestId("resume-source-sync")).toBeVisible();
  await prepareInitialDocuments();
  await page.getByTestId("resume-source-sync").click();
  await expectSyncResult(page, { created: 10, changed: 0, skipped: 0, tombstones: 0 });
  const dbAfterRecovery = await database();
  const [recoveredRun] = await dbAfterRecovery.select().from(enterpriseAssetSourceRuns)
    .where(eq(enterpriseAssetSourceRuns.sourceId, sourceId))
    .orderBy(desc(enterpriseAssetSourceRuns.startedAt), desc(enterpriseAssetSourceRuns.id))
    .limit(1);
  expect(recoveredRun?.resumeOfRunId).toBeTruthy();
  expect(recoveredRun?.attempt).toBe(2);

  await writeFile(path.join(sourceRoot, "wealth-policy-01-V1.0.md"), document(1, 1));
  await writeFile(path.join(sourceRoot, "wealth-policy-02-V1.0.md"), document(2, 1));
  await writeFile(path.join(sourceRoot, "wealth-policy-11-V1.0.md"), document(11));
  await syncAndExpect(page, { created: 1, changed: 2, skipped: 8, tombstones: 0 });

  const db = await database();
  const [beforeRename] = await db.select().from(enterpriseAssetSourceItems).where(and(
    eq(enterpriseAssetSourceItems.sourceId, sourceId),
    eq(enterpriseAssetSourceItems.relativePath, "wealth-policy-03-V1.0.md"),
  )).limit(1);
  expect(beforeRename).toBeTruthy();
  await rename(path.join(sourceRoot, "wealth-policy-03-V1.0.md"), path.join(sourceRoot, "renamed-wealth-policy-03-V1.0.md"));
  await syncAndExpect(page, { created: 0, changed: 1, skipped: 10, tombstones: 0 });
  const [afterRename] = await db.select().from(enterpriseAssetSourceItems).where(and(
    eq(enterpriseAssetSourceItems.sourceId, sourceId),
    eq(enterpriseAssetSourceItems.relativePath, "renamed-wealth-policy-03-V1.0.md"),
  )).limit(1);
  expect(afterRename?.sourceItemId).toBe(beforeRename.sourceItemId);
  expect(afterRename?.enterpriseAssetId).toBe(beforeRename.enterpriseAssetId);

  await rm(path.join(sourceRoot, "wealth-policy-04-V1.0.md"));
  await syncAndExpect(page, { created: 0, changed: 0, skipped: 10, tombstones: 1 });
  await expect(page.getByText("完整来源扫描确认文件已删除；需完成影响分析后人工决定退役或恢复")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("connector-operations-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("source-operations")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("connector-operations-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  const candidateRow = page.getByText("wealth-policy-01-V1.0.md", { exact: true }).first().locator("xpath=ancestor::div[contains(@class,'xl:flex-row')][1]");
  await candidateRow.getByRole("button", { name: "提交审核" }).click();
  const reviewDialog = page.getByRole("dialog", { name: "确认企业资产信息" });
  await expect(reviewDialog.getByText("字段建议不代表资产可信度", { exact: false })).toBeVisible();
  await reviewDialog.locator('input[type="datetime-local"]').first().fill("2026-09-01T09:00");
  const wealthManagerRole = reviewDialog.locator('label:has-text("财富经理") input[type="checkbox"]');
  if (!await wealthManagerRole.isChecked()) await wealthManagerRole.check();
  await expect(reviewDialog.getByRole("button", { name: "提交审核" })).toBeEnabled();
  await reviewDialog.getByRole("button", { name: "提交审核" }).click();
  await expect(page.getByText("已提交审核")).toBeVisible();
  await expect(page.getByText("待审核", { exact: true }).first()).toBeVisible();
});
