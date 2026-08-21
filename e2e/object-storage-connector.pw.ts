import "dotenv/config";
import { expect, test, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  enterpriseAssetCandidates,
  enterpriseAssetSourceItems,
  enterpriseAssetSourceRuns,
  enterpriseAssetSources,
  users,
} from "../drizzle/schema";
import { closeDbConnection, getDb } from "../server/db/connection";

const suffix = `${Date.now()}-${process.pid}`;
const sourceId = `e2e-obs-${suffix}`;
const sourceName = `E2E OBS 财富制度源 ${suffix}`;
const email = `obs-connector-e2e-${suffix}@local.test`;
const password = `Connector-${suffix}!`;
const endpoint = "http://127.0.0.1:5903";
const stagingRoot = path.join(process.cwd(), "data", "e2e-enterprise-asset-candidates");
const bucket = "demo-bank";
const prefix = "wealth/";

type StoredObject = { content: string; etag: string; lastModified: string };
const objects = new Map<string, StoredObject>();
let rejectDownloads = false;
let server: Server;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function listResponse(url: URL): string {
  const requestedPrefix = url.searchParams.get("prefix") || "";
  const start = Number(url.searchParams.get("continuation-token") || "0");
  const keys = [...objects.keys()].filter(key => key.startsWith(requestedPrefix)).sort();
  const pageKeys = keys.slice(start, start + 2);
  const next = start + pageKeys.length;
  const truncated = next < keys.length;
  const contents = pageKeys.map(key => {
    const item = objects.get(key)!;
    return `<Contents><Key>${escapeXml(key)}</Key><LastModified>${item.lastModified}</LastModified><ETag>&quot;${escapeXml(item.etag)}&quot;</ETag><Size>${Buffer.byteLength(item.content)}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
  }).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    `<Name>${bucket}</Name><Prefix>${escapeXml(requestedPrefix)}</Prefix><KeyCount>${pageKeys.length}</KeyCount><MaxKeys>2</MaxKeys>`,
    `<IsTruncated>${String(truncated)}</IsTruncated>${contents}`,
    truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : "",
    "</ListBucketResult>",
  ].join("");
}

function startObjectStorageServer(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const instance = createServer((request, response) => {
      const url = new URL(request.url || "/", endpoint);
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(listResponse(url));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith(`/${bucket}/`)) {
        if (rejectDownloads) {
          response.writeHead(503, { "content-type": "application/xml" });
          response.end("<Error><Code>ServiceUnavailable</Code><Message>simulated download failure</Message></Error>");
          return;
        }
        const key = decodeURIComponent(url.pathname.slice(`/${bucket}/`.length));
        const item = objects.get(key);
        if (!item) {
          response.writeHead(404, { "content-type": "application/xml" });
          response.end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(Buffer.byteLength(item.content)),
          etag: `"${item.etag}"`,
          "last-modified": new Date(item.lastModified).toUTCString(),
        });
        response.end(item.content);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    instance.once("error", reject);
    instance.listen(5903, "127.0.0.1", () => resolve(instance));
  });
}

function document(index: number, revision = 0): string {
  return `# 演示银行财富制度 ${index} V1.0\n适用部门：财富管理部\n当前修订：${revision}\n`;
}

function setObject(index: number, revision = 0): void {
  objects.set(`${prefix}policy-${index}-V1.0.md`, {
    content: document(index, revision),
    etag: `etag-${index}-${revision}`,
    lastModified: new Date(Date.UTC(2026, 7, 21, 1 + revision, index, 0)).toISOString(),
  });
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
  await rm(stagingRoot, { recursive: true, force: true });
}

async function login(page: Page): Promise<void> {
  await page.goto("/login?redirect=%2Fadmin");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function selectSource(page: Page): Promise<void> {
  await page.getByRole("combobox", { name: "选择来源同步状态" }).click();
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

test.beforeAll(async () => {
  await cleanup();
  server = await startObjectStorageServer();
  for (let index = 1; index <= 3; index += 1) setObject(index);
  const db = await database();
  await db.insert(users).values({
    name: "OBS Connector E2E Admin",
    email,
    password: await bcrypt.hash(password, 10),
    loginMethod: "email",
    role: "admin",
    accessLevel: "all",
    lastSignedIn: new Date(),
  });
});

test.afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await cleanup();
  await closeDbConnection();
});

test("administrator can operate the OBS/S3 connector lifecycle", async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole("tab", { name: /岗位资产接入/ }).click();
  await page.getByRole("button", { name: "登记来源" }).click();
  const sourceDialog = page.getByRole("dialog", { name: "登记企业资产来源" });
  const sourceInputs = sourceDialog.locator("input");
  await sourceInputs.nth(0).fill(sourceId);
  await sourceInputs.nth(1).fill(sourceName);
  await sourceInputs.nth(2).fill("财富管理部");
  await sourceDialog.getByRole("combobox", { name: "接入方式" }).click();
  await page.getByRole("option", { name: "OBS / S3 对象存储" }).click();
  await sourceDialog.getByTestId("object-storage-endpoint").fill(endpoint);
  await sourceDialog.getByTestId("object-storage-bucket").fill(bucket);
  await sourceDialog.getByTestId("object-storage-prefix").fill(prefix);
  await sourceDialog.getByTestId("object-storage-region").fill("cn-east-3");
  await sourceDialog.getByTestId("object-storage-credential-ref").fill("env://EA_CONNECTOR_E2E_OBS");
  await expect(sourceDialog.getByText("Access Key 和 Secret Key 必须由服务端", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("obs-source-registration-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sourceDialog.getByTestId("object-storage-source-fields")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("obs-source-registration-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await sourceDialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("接入来源已保存")).toBeVisible();

  await selectSource(page);
  rejectDownloads = true;
  await page.getByTestId("sync-selected-source").click();
  await expect(page.getByTestId("source-operations").getByText("失败原因：", { exact: false })).toBeVisible();
  await expect(page.getByTestId("resume-source-sync")).toBeVisible();
  rejectDownloads = false;
  await page.getByTestId("resume-source-sync").click();
  await expectSyncResult(page, { created: 3, changed: 0, skipped: 0, tombstones: 0 });

  setObject(1, 1);
  setObject(4);
  await page.getByTestId("sync-selected-source").click();
  await expectSyncResult(page, { created: 1, changed: 1, skipped: 2, tombstones: 0 });

  objects.delete(`${prefix}policy-3-V1.0.md`);
  await page.getByTestId("sync-selected-source").click();
  await expectSyncResult(page, { created: 0, changed: 0, skipped: 3, tombstones: 1 });
  await expect(page.getByText("完整来源扫描确认文件已删除；需完成影响分析后人工决定退役或恢复")).toBeVisible();

  const db = await database();
  const [savedSource] = await db.select().from(enterpriseAssetSources).where(eq(enterpriseAssetSources.sourceId, sourceId)).limit(1);
  expect(savedSource.sourceUri).toContain("credentialRef=env%3A%2F%2FEA_CONNECTOR_E2E_OBS");
  expect(savedSource.sourceUri).not.toContain("test-secret-key");

  await page.screenshot({ path: testInfo.outputPath("obs-connector-operations-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("source-operations")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("obs-connector-operations-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  const candidateRow = page.getByText("policy-1-V1.0.md", { exact: true }).first().locator("xpath=ancestor::div[contains(@class,'xl:flex-row')][1]");
  await candidateRow.getByRole("button", { name: "提交审核" }).click();
  const reviewDialog = page.getByRole("dialog", { name: "确认企业资产信息" });
  await reviewDialog.locator('input[type="datetime-local"]').first().fill("2026-09-01T09:00");
  const wealthManagerRole = reviewDialog.locator('label:has-text("财富经理") input[type="checkbox"]');
  if (!await wealthManagerRole.isChecked()) await wealthManagerRole.check();
  await reviewDialog.getByRole("button", { name: "提交审核" }).click();
  await expect(page.getByText("已提交审核")).toBeVisible();
});
