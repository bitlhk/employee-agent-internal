import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentMemoryItems,
  agentMemoryVersions,
  governedWorkItems,
} from "../../drizzle/schema";
import type { MemoryRetrievalScopeV1 } from "../../shared/memory-purpose";
import type { ContextSourceBindingV1 } from "../../shared/context-resolution";
import { retrieveGovernedRelationshipMemory } from "../_core/context-resolution/governed-memory-provider";
import type { RuntimePrincipalV2 } from "../_core/governance/contracts";
import { createAgentMemory, listAgentMemoriesForPurpose } from "./agent-memory";
import { closeDbConnection, getDb } from "./connection";
import { createGovernedWorkItemDrafts, listGovernedWorkItemsForPurpose } from "./governed-work-items";

const run = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const organizationId = `org-purpose-${suffix}`;
const subjectId = `customer-${suffix}`;
const otherSubjectId = `customer-other-${suffix}`;
const memoryIds: number[] = [];
const workItemIds: string[] = [];

const wealth: MemoryRetrievalScopeV1 = {
  organizationId,
  userId: 920001,
  adoptionId: `lgj-wm-${suffix}`,
  roleTemplate: "wealth-manager",
  rolePackId: "linggan-bank.wealth-manager",
  purposeId: "wealth_advisory",
  requestedPurpose: "财富客户经营",
  subjectId,
};
const insurance: MemoryRetrievalScopeV1 = {
  ...wealth,
  userId: 920002,
  adoptionId: `lgj-ia-${suffix}`,
  roleTemplate: "insurance-advisor",
  rolePackId: "linggan-insurance.insurance-advisor",
  purposeId: "insurance_advisory",
  requestedPurpose: "保险客户经营",
};
const sharedMemoryBinding: ContextSourceBindingV1 = {
  schema: "ea.context-source-binding.v1",
  bindingId: `ctxb-shared-memory-${suffix}`,
  organizationId,
  rolePackId: "*",
  bindingScope: "enterprise_shared",
  logicalAssetId: "customer_relationship_memory",
  contextType: "memory",
  providerType: "api",
  resourceRef: "api://employee-agent/agent-memory/relevant",
  capabilities: ["relevant_retrieval", "purpose_filter"],
  bindingVersion: "purpose-v1",
  stage: "shadow",
  status: "active",
};

function principal(scope: MemoryRetrievalScopeV1, agentId: string): RuntimePrincipalV2 {
  return {
    tenantId: "tn-purpose-integration",
    organizationId,
    userId: scope.userId,
    adoptionId: scope.adoptionId,
    agentId,
    roleTemplate: scope.roleTemplate,
    workspaceId: `/purpose/${scope.adoptionId}`,
    permissionProfile: "plus",
    sessionId: `session-${suffix}`,
    authorizationSnapshotId: `authz-${agentId}-${suffix}`,
    authorizationFingerprint: agentId === "wealth" ? "b".repeat(64) : "c".repeat(64),
    identityVersion: "2",
  };
}

function provenance(source: "human_confirmed" | "governed_work") {
  return { source, recordedBy: "purpose-isolation-integration", recordedAt: new Date().toISOString() };
}

run("governed memory Purpose isolation persistence", () => {
  beforeAll(async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required for DB integration tests");
    await db.select().from(agentMemoryItems).limit(1);
    await db.select().from(governedWorkItems).limit(1);
  });

  afterAll(async () => {
    const db = await getDb();
    if (db) {
      if (memoryIds.length) {
        await db.delete(agentMemoryVersions).where(inArray(agentMemoryVersions.memoryId, memoryIds));
        await db.delete(agentMemoryItems).where(inArray(agentMemoryItems.id, memoryIds));
      }
      if (workItemIds.length) await db.delete(governedWorkItems).where(inArray(governedWorkItems.workItemId, workItemIds));
    }
    await closeDbConnection();
  });

  it("returns private records only to their principal and shared records to both allowed Purposes", async () => {
    const records = [
      { owner: wealth, key: `wealth.private.${suffix}`, content: "财富岗位私有客户准备事项", visibilityClass: "principal_private" as const, purposeIds: ["wealth_advisory"], subjectId },
      { owner: insurance, key: `insurance.private.${suffix}`, content: "保险岗位私有客户续保事项", visibilityClass: "principal_private" as const, purposeIds: ["insurance_advisory"], subjectId },
      { owner: wealth, key: `shared.fact.${suffix}`, content: "客户确认的跨岗位保障与资产沟通事实", visibilityClass: "enterprise_shared" as const, purposeIds: ["wealth_advisory", "insurance_advisory"], subjectId },
      { owner: wealth, key: `other.subject.${suffix}`, content: "其他客户的跨岗位沟通事实", visibilityClass: "enterprise_shared" as const, purposeIds: ["wealth_advisory", "insurance_advisory"], subjectId: otherSubjectId },
    ];
    for (const record of records) {
      const created = await createAgentMemory({
        userId: record.owner.userId,
        adoptId: record.owner.adoptionId,
        roleTemplate: record.owner.roleTemplate,
        organizationId,
        visibilityClass: record.visibilityClass,
        purposeIds: record.purposeIds,
        purposeScopeVersion: "1",
        subjectId: record.subjectId,
        scopeProvenance: provenance("human_confirmed"),
        scope: "role",
        kind: "entity",
        status: "active",
        canonicalKey: record.key,
        content: record.content,
        source: "explicit",
        confidence: 100,
      });
      memoryIds.push(created.id);
    }

    const wealthResult = await listAgentMemoriesForPurpose({ scope: wealth, statuses: ["active"] });
    const insuranceResult = await listAgentMemoriesForPurpose({ scope: insurance, statuses: ["active"] });
    expect(wealthResult.memories.map(item => item.canonicalKey).sort()).toEqual([
      `shared.fact.${suffix}`,
      `wealth.private.${suffix}`,
    ]);
    expect(insuranceResult.memories.map(item => item.canonicalKey).sort()).toEqual([
      `insurance.private.${suffix}`,
      `shared.fact.${suffix}`,
    ]);
    expect(wealthResult.filteredRecordCount).toBe(2);
    expect(insuranceResult.filteredRecordCount).toBe(2);
  });

  it("applies the same cross-purpose matrix to governed Work State", async () => {
    const records = [
      { owner: wealth, id: `gwk-wm-${suffix}`, subject: "财富岗位私有工作", visibilityClass: "principal_private" as const, purposeIds: ["wealth_advisory"], subjectId },
      { owner: insurance, id: `gwk-ia-${suffix}`, subject: "保险岗位私有工作", visibilityClass: "principal_private" as const, purposeIds: ["insurance_advisory"], subjectId },
      { owner: wealth, id: `gwk-shared-${suffix}`, subject: "客户确认的企业共享跟进事实", visibilityClass: "enterprise_shared" as const, purposeIds: ["wealth_advisory", "insurance_advisory"], subjectId },
      { owner: wealth, id: `gwk-other-${suffix}`, subject: "其他客户工作", visibilityClass: "enterprise_shared" as const, purposeIds: ["wealth_advisory", "insurance_advisory"], subjectId: otherSubjectId },
    ];
    await createGovernedWorkItemDrafts(records.map(record => {
      workItemIds.push(record.id);
      return {
        workItemId: record.id,
        organizationId,
        userId: record.owner.userId,
        adoptId: record.owner.adoptionId,
        roleTemplate: record.owner.roleTemplate,
        visibilityClass: record.visibilityClass,
        purposeScopeJson: record.purposeIds,
        purposeScopeVersion: "1",
        subjectId: record.subjectId,
        scopeProvenanceJson: provenance("governed_work"),
        type: "action_item" as const,
        subject: record.subject,
        status: "open" as const,
        sourceId: `meeting-${suffix}`,
        sourceFingerprint: "a".repeat(64),
        sourceExcerpt: record.subject,
        extractionJson: { extractor: "integration", extractorVersion: "v1", sourceExcerpt: record.subject, extractedFields: ["type", "subject"] },
        confirmedBy: "purpose-isolation-integration",
        confirmedAt: new Date(),
        relatedContextJson: ["governed_work_state"],
      };
    }));

    const wealthResult = await listGovernedWorkItemsForPurpose({ scope: wealth, statuses: ["open"] });
    const insuranceResult = await listGovernedWorkItemsForPurpose({ scope: insurance, statuses: ["open"] });
    expect(wealthResult.items.map(item => item.workItemId).sort()).toEqual([`gwk-shared-${suffix}`, `gwk-wm-${suffix}`]);
    expect(insuranceResult.items.map(item => item.workItemId).sort()).toEqual([`gwk-ia-${suffix}`, `gwk-shared-${suffix}`]);
    expect(wealthResult.filteredRecordCount).toBe(2);
    expect(insuranceResult.filteredRecordCount).toBe(2);
  });

  it("records the applied Purpose filter in relationship-memory Receipts", async () => {
    const wealthResult = await retrieveGovernedRelationshipMemory({
      principal: principal(wealth, "wealth"),
      rolePackId: wealth.rolePackId,
      taskId: "WM-PURPOSE-01",
      binding: sharedMemoryBinding,
      adoptionRecordId: 991000001,
      purposeId: wealth.purposeId,
      purpose: wealth.requestedPurpose,
      query: "客户确认的跨岗位保障与资产沟通事实",
      subjectId,
    });
    const insuranceResult = await retrieveGovernedRelationshipMemory({
      principal: principal(insurance, "insurance"),
      rolePackId: insurance.rolePackId,
      taskId: "IA-PURPOSE-01",
      binding: sharedMemoryBinding,
      adoptionRecordId: 991000002,
      purposeId: insurance.purposeId,
      purpose: insurance.requestedPurpose,
      query: "客户确认的跨岗位保障与资产沟通事实",
      subjectId,
    });

    expect(wealthResult.receipt.resolution?.needs[0]).toMatchObject({
      bindingId: sharedMemoryBinding.bindingId,
      purposeFilter: { requestedPurposeId: "wealth_advisory", appliedPurposeFilter: true },
    });
    expect(insuranceResult.receipt.resolution?.needs[0]).toMatchObject({
      bindingId: sharedMemoryBinding.bindingId,
      purposeFilter: { requestedPurposeId: "insurance_advisory", appliedPurposeFilter: true },
    });
    expect(wealthResult.receipt.provided.memory.some(item => item.purposeId === "wealth_advisory")).toBe(true);
    expect(insuranceResult.receipt.provided.memory.some(item => item.purposeId === "insurance_advisory")).toBe(true);
    expect(wealthResult.receipt.principalFingerprint).not.toBe(insuranceResult.receipt.principalFingerprint);
  });
});
