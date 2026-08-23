import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { governedWorkItemExecutions, governedWorkItems } from "../../drizzle/schema";
import {
  createGovernedWorkItemDrafts,
  executeGovernedWorkItemTransition,
  getGovernedWorkItem,
  listGovernedWorkItems,
} from "./governed-work-items";
import { closeDbConnection, getDb } from "./connection";

const run = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const suffix = randomUUID();
const workItemId = `gwk_${suffix}`;
const secondWorkItemId = `gwk_${randomUUID()}`;
const scope = { organizationId: `org-${suffix}`, userId: 7, adoptId: `lgj-${suffix}` };

run("governed work continuity persistence", () => {
  beforeAll(async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required for DB integration tests");
    await db.select().from(governedWorkItems).limit(1);
    await db.select().from(governedWorkItemExecutions).limit(1);
  });

  afterAll(async () => {
    const db = await getDb();
    if (db) {
      await db.delete(governedWorkItemExecutions).where(eq(governedWorkItemExecutions.workItemId, workItemId));
      await db.delete(governedWorkItemExecutions).where(eq(governedWorkItemExecutions.workItemId, secondWorkItemId));
      await db.delete(governedWorkItems).where(eq(governedWorkItems.workItemId, workItemId));
      await db.delete(governedWorkItems).where(eq(governedWorkItems.workItemId, secondWorkItemId));
    }
    await closeDbConnection();
  });

  it("keeps drafts scoped and performs one idempotent confirmed transition", async () => {
    const [draft] = await createGovernedWorkItemDrafts([{
      workItemId,
      ...scope,
      roleTemplate: "wealth-manager",
      type: "action_item",
      subject: "准备王总资产配置方案",
      description: "小李周三前准备王总资产配置方案",
      ownerDisplayName: "小李",
      dueAt: new Date("2026-08-26T10:00:00.000Z"),
      sourceId: `meeting-${suffix}`,
      sourceFingerprint: "a".repeat(64),
      sourceExcerpt: "小李周三前准备王总资产配置方案",
      extractionJson: { extractor: "deterministic", extractorVersion: "v1", sourceExcerpt: "小李周三前准备王总资产配置方案", extractedFields: ["type"] },
      relatedContextJson: ["customer_profile"],
    }]);
    expect(draft.status).toBe("draft");
    await expect(getGovernedWorkItem({ ...scope, organizationId: `${scope.organizationId}-other` }, workItemId)).resolves.toBeNull();
    await expect(getGovernedWorkItem({ ...scope, userId: 8 }, workItemId)).resolves.toBeNull();
    await expect(getGovernedWorkItem({ ...scope, adoptId: `${scope.adoptId}-other` }, workItemId)).resolves.toBeNull();
    await expect(listGovernedWorkItems({ ...scope, statuses: ["open"] })).resolves.toEqual([]);

    const transition = {
      ...scope,
      executionReceiptId: `wex_${randomUUID()}`,
      workItemId,
      operation: "confirm" as const,
      expectedStatuses: ["draft" as const],
      toStatus: "open" as const,
      requestedBy: "integration-test",
      confirmedBy: "integration-test",
      confirmedAt: new Date(),
      idempotencyKey: `confirm-${suffix}`,
      payloadHash: "b".repeat(64),
      contextReceiptFingerprint: "c".repeat(64),
      resultFingerprint: "d".repeat(64),
    };
    const first = await executeGovernedWorkItemTransition(transition);
    expect(first).toMatchObject({ reused: false, item: { status: "open", version: 2 }, execution: { status: "completed" } });
    const replay = await executeGovernedWorkItemTransition({ ...transition, executionReceiptId: `wex_${randomUUID()}` });
    expect(replay).toMatchObject({ reused: true, item: { status: "open" } });
    await expect(executeGovernedWorkItemTransition({
      ...transition,
      executionReceiptId: `wex_${randomUUID()}`,
      workItemId: `gwk_${randomUUID()}`,
    })).rejects.toThrow("IDEMPOTENCY_CONFLICT");

    const secondScope = { ...scope, userId: 8 };
    await createGovernedWorkItemDrafts([{
      workItemId: secondWorkItemId,
      ...secondScope,
      roleTemplate: "wealth-manager",
      type: "action_item",
      subject: "准备另一客户的配置方案",
      description: "同一岗位实例下另一用户的工作事项",
      ownerDisplayName: "小王",
      dueAt: new Date("2026-08-27T10:00:00.000Z"),
      sourceId: `meeting-${suffix}-2`,
      sourceFingerprint: "e".repeat(64),
      sourceExcerpt: "小王周四前准备另一客户的配置方案",
      extractionJson: { extractor: "deterministic", extractorVersion: "v1", sourceExcerpt: "小王周四前准备另一客户的配置方案", extractedFields: ["type"] },
      relatedContextJson: ["customer_profile"],
    }]);
    const second = await executeGovernedWorkItemTransition({
      ...transition,
      ...secondScope,
      executionReceiptId: `wex_${randomUUID()}`,
      workItemId: secondWorkItemId,
    });
    expect(second).toMatchObject({ reused: false, item: { userId: 8, status: "open" } });
    await expect(getGovernedWorkItem(scope, secondWorkItemId)).resolves.toBeNull();
  });
});
