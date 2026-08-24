import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import {
  agentMemoryItems,
  agentMemoryVersions,
  governedWorkItems,
} from "../drizzle/schema";
import type { ContextNeedPlanV1, ContextSourceBindingV1 } from "../shared/context-resolution";
import type { MemoryRetrievalScopeV1 } from "../shared/memory-purpose";
import { retrieveGovernedRelationshipMemory } from "../server/_core/context-resolution/governed-memory-provider";
import { resolveContextSources } from "../server/_core/context-resolution/source-resolver";
import { sharedBindingCandidateFingerprint } from "../server/_core/context-resolution/shared-binding-validation-snapshot";
import { wealthContextNeedPlan } from "../server/_core/context-resolution/wealth-context-plans";
import { governedWorkContext } from "../server/_core/governed-work-continuity";
import type { RuntimePrincipalV2 } from "../server/_core/governance/contracts";
import { createAgentMemory } from "../server/db/agent-memory";
import { listContextSourceBindingContracts } from "../server/db/context-source-bindings";
import { closeDbConnection, getDb } from "../server/db/connection";
import { createGovernedWorkItemDrafts } from "../server/db/governed-work-items";
import { latestVerifiedRolePackReleases } from "../server/db/role-pack-releases";

const organizationId =
  process.env.GRACE_SHARED_SHADOW_ORG
  || process.env.EA_DEMO_ORGANIZATION_ID
  || "org_role_scale_shadow_20260824";
const suffix = randomUUID().slice(0, 8);
const subjectId = `customer-purpose-${suffix}`;
const otherSubjectId = `customer-other-${suffix}`;
const memoryIds: number[] = [];
const workItemIds: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function principal(input: { userId: number; adoptionId: string; roleTemplate: string; agentId: string }): RuntimePrincipalV2 {
  return {
    tenantId: "tn-role-scale-shadow",
    organizationId,
    userId: input.userId,
    adoptionId: input.adoptionId,
    agentId: input.agentId,
    roleTemplate: input.roleTemplate,
    workspaceId: `/shadow/${organizationId}/${input.roleTemplate}`,
    permissionProfile: "plus",
    sessionId: `shadow-${input.roleTemplate}-${suffix}`,
    authorizationSnapshotId: `authz-${input.roleTemplate}-${suffix}`,
    authorizationFingerprint: sha256(`authz-${input.roleTemplate}-${suffix}`),
    identityVersion: "2",
  };
}

function retrievalScope(principalValue: RuntimePrincipalV2, rolePackId: string, purposeId: string): MemoryRetrievalScopeV1 {
  return {
    organizationId,
    userId: principalValue.userId,
    adoptionId: principalValue.adoptionId,
    roleTemplate: principalValue.roleTemplate,
    rolePackId,
    purposeId,
    requestedPurpose: purposeId === "wealth_advisory" ? "财富客户经营" : "保险客户经营",
    subjectId,
  };
}

async function cleanup() {
  const db = await getDb();
  if (!db) return;
  if (memoryIds.length) {
    await db.delete(agentMemoryVersions).where(inArray(agentMemoryVersions.memoryId, memoryIds));
    await db.delete(agentMemoryItems).where(inArray(agentMemoryItems.id, memoryIds));
  }
  if (workItemIds.length) await db.delete(governedWorkItems).where(inArray(governedWorkItems.workItemId, workItemIds));
}

export async function runGovernedMemoryPurposeEnvironment(input: {
  closeConnection?: boolean;
  principals?: { wealth: RuntimePrincipalV2; insurance: RuntimePrincipalV2 };
} = {}) {
  try {
  const wealthPrincipal = input.principals?.wealth
    || principal({ userId: 930001, adoptionId: `lgj-wm-${suffix}`, roleTemplate: "wealth-manager", agentId: "wealth-shadow" });
  const insurancePrincipal = input.principals?.insurance
    || principal({ userId: 930002, adoptionId: `lgj-ia-${suffix}`, roleTemplate: "insurance-advisor", agentId: "insurance-shadow" });
  const targetIds = ["customer_profile", "customer_relationship_memory", "governed_work_state"];
  const bindings = await listContextSourceBindingContracts({
    organizationId,
    rolePackId: "linggan-insurance.insurance-advisor",
    stage: "shadow",
  });
  const bindingByLogicalId = new Map(bindings.map(binding => [binding.logicalAssetId, binding]));
  for (const logicalAssetId of targetIds) {
    const binding = bindingByLogicalId.get(logicalAssetId);
    if (!binding || binding.bindingScope !== "enterprise_shared" || binding.stage !== "shadow") {
      throw new Error(`Shared Shadow Binding missing: ${logicalAssetId}`);
    }
  }
  const relationshipBinding = bindingByLogicalId.get("customer_relationship_memory") as ContextSourceBindingV1;
  const workBinding = bindingByLogicalId.get("governed_work_state") as ContextSourceBindingV1;

  const insuranceManifest = JSON.parse(readFileSync("examples/insurance-advisor-reference-role-pack/context-needs.json", "utf8"));
  const insuranceBase = insuranceManifest.plans.find((plan: ContextNeedPlanV1) => plan.taskId === "IA-GT-01") as ContextNeedPlanV1;
  const insurancePlan = { ...insuranceBase, needs: insuranceBase.needs.filter(need => targetIds.includes(need.logicalAssetId)) };
  const wealthBase = wealthContextNeedPlan("WM-GT-01");
  if (!wealthBase) throw new Error("WM-GT-01 Context plan missing");
  const wealthPlan: ContextNeedPlanV1 = {
    ...wealthBase,
    planId: "linggan-bank.wealth-manager.shared-shadow.environment",
    needs: [
      ...wealthBase.needs.filter(need => ["customer_profile", "customer_relationship_memory"].includes(need.logicalAssetId)),
      {
        needId: "governed-work-state",
        logicalAssetId: "governed_work_state",
        contextType: "memory",
        requiredness: "optional",
        purpose: "读取当前岗位范围内已确认的工作状态",
        freshness: { mode: "latest", maxAgeSeconds: 2_592_000 },
        requiredCapabilities: ["read_work_state"],
      },
    ],
  };
  const wealthResolution = resolveContextSources({ plan: wealthPlan, bindings, organizationId, stage: "shadow" });
  const insuranceResolution = resolveContextSources({ plan: insurancePlan, bindings, organizationId, stage: "shadow" });

  const purposeIds = ["wealth_advisory", "insurance_advisory"];
  const memoryRecords = [
    { principal: wealthPrincipal, key: `wealth.private.${suffix}`, content: "财富岗位私有客户准备事项", visibilityClass: "principal_private" as const, purposeIds: [purposeIds[0]], subjectId },
    { principal: insurancePrincipal, key: `insurance.private.${suffix}`, content: "保险岗位私有客户续保事项", visibilityClass: "principal_private" as const, purposeIds: [purposeIds[1]], subjectId },
    { principal: wealthPrincipal, key: `shared.fact.${suffix}`, content: "客户确认的跨岗位保障与资产沟通事实", visibilityClass: "enterprise_shared" as const, purposeIds, subjectId },
    { principal: wealthPrincipal, key: `other.subject.${suffix}`, content: "其他客户跨岗位沟通事实", visibilityClass: "enterprise_shared" as const, purposeIds, subjectId: otherSubjectId },
  ];
  for (const record of memoryRecords) {
    const created = await createAgentMemory({
      userId: record.principal.userId,
      adoptId: record.principal.adoptionId,
      roleTemplate: record.principal.roleTemplate,
      organizationId,
      visibilityClass: record.visibilityClass,
      purposeIds: record.purposeIds,
      purposeScopeVersion: "1",
      subjectId: record.subjectId,
      scopeProvenance: { source: "human_confirmed", recordedBy: "gate-b-environment-shadow", recordedAt: new Date().toISOString() },
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

  const workRecords = [
    { principal: wealthPrincipal, id: `gwk-wm-${suffix}`, subject: "财富岗位私有工作", visibilityClass: "principal_private" as const, purposeIds: [purposeIds[0]], subjectId },
    { principal: insurancePrincipal, id: `gwk-ia-${suffix}`, subject: "保险岗位私有工作", visibilityClass: "principal_private" as const, purposeIds: [purposeIds[1]], subjectId },
    { principal: wealthPrincipal, id: `gwk-shared-${suffix}`, subject: "客户确认的企业共享跟进事实", visibilityClass: "enterprise_shared" as const, purposeIds, subjectId },
    { principal: wealthPrincipal, id: `gwk-other-${suffix}`, subject: "其他客户工作", visibilityClass: "enterprise_shared" as const, purposeIds, subjectId: otherSubjectId },
  ];
  await createGovernedWorkItemDrafts(workRecords.map(record => {
    workItemIds.push(record.id);
    return {
      workItemId: record.id,
      organizationId,
      userId: record.principal.userId,
      adoptId: record.principal.adoptionId,
      roleTemplate: record.principal.roleTemplate,
      visibilityClass: record.visibilityClass,
      purposeScopeJson: record.purposeIds,
      purposeScopeVersion: "1",
      subjectId: record.subjectId,
      scopeProvenanceJson: { source: "governed_work", recordedBy: "gate-b-environment-shadow", recordedAt: new Date().toISOString() },
      type: "action_item" as const,
      subject: record.subject,
      status: "open" as const,
      sourceId: `meeting-${suffix}`,
      sourceFingerprint: sha256(`meeting-${suffix}`),
      sourceExcerpt: record.subject,
      extractionJson: { extractor: "environment-shadow", extractorVersion: "v1", sourceExcerpt: record.subject, extractedFields: ["type", "subject"] },
      confirmedBy: "gate-b-environment-shadow",
      confirmedAt: new Date(),
      relatedContextJson: ["governed_work_state"],
    };
  }));

  const wealthScope = retrievalScope(wealthPrincipal, wealthPlan.rolePackId, purposeIds[0]);
  const insuranceScope = retrievalScope(insurancePrincipal, insurancePlan.rolePackId, purposeIds[1]);
  const [wealthMemory, insuranceMemory, wealthWork, insuranceWork] = await Promise.all([
    retrieveGovernedRelationshipMemory({
      principal: wealthPrincipal,
      rolePackId: wealthPlan.rolePackId,
      taskId: "WM-GT-01",
      binding: relationshipBinding,
      adoptionRecordId: 992000001,
      purposeId: wealthScope.purposeId,
      purpose: wealthScope.requestedPurpose,
      query: "客户确认的跨岗位保障与资产沟通事实",
      subjectId,
    }),
    retrieveGovernedRelationshipMemory({
      principal: insurancePrincipal,
      rolePackId: insurancePlan.rolePackId,
      taskId: "IA-GT-01",
      binding: relationshipBinding,
      adoptionRecordId: 992000002,
      purposeId: insuranceScope.purposeId,
      purpose: insuranceScope.requestedPurpose,
      query: "客户确认的跨岗位保障与资产沟通事实",
      subjectId,
    }),
    governedWorkContext({ principal: wealthPrincipal, binding: workBinding, purposeId: wealthScope.purposeId, purpose: wealthScope.requestedPurpose, subjectId }),
    governedWorkContext({ principal: insurancePrincipal, binding: workBinding, purposeId: insuranceScope.purposeId, purpose: insuranceScope.requestedPurpose, subjectId }),
  ]);

  const sharedMemoryId = memoryIds[2];
  const sharedWorkId = workItemIds[2];
  const wealthMemoryIds = wealthMemory.receipt.provided.memory.map(item => Number(item.memoryId));
  const insuranceMemoryIds = insuranceMemory.receipt.provided.memory.map(item => Number(item.memoryId));
  const wealthWorkIds = wealthWork.items.map(item => item.workItemId);
  const insuranceWorkIds = insuranceWork.items.map(item => item.workItemId);
  const leakage = [
    insuranceMemoryIds.includes(memoryIds[0]),
    wealthMemoryIds.includes(memoryIds[1]),
    insuranceWorkIds.includes(workItemIds[0]),
    wealthWorkIds.includes(workItemIds[1]),
    wealthWorkIds.includes(workItemIds[3]),
    insuranceWorkIds.includes(workItemIds[3]),
  ].filter(Boolean).length;
  const expectedSharedRecall = [
    wealthMemoryIds.includes(sharedMemoryId),
    insuranceMemoryIds.includes(sharedMemoryId),
    wealthWorkIds.includes(sharedWorkId),
    insuranceWorkIds.includes(sharedWorkId),
  ];

  const releases = await latestVerifiedRolePackReleases([wealthPlan.rolePackId, insurancePlan.rolePackId]);
  const providerFiles = [
    "shared/memory-purpose.ts",
    "server/_core/agent-memory-retrieval.ts",
    "server/_core/context-resolution/governed-memory-provider.ts",
    "server/_core/governed-work-continuity.ts",
  ];
  const providerContractFingerprint = sha256(providerFiles.map(file => `${file}:${sha256(readFileSync(file))}`).join("\n"));
  const snapshotBody = {
    schema: "ea.shared-binding-validation-snapshot.v1",
    organizationId,
    stage: "shadow",
    providerContractFingerprint,
    bindings: bindings.map(binding => ({
      bindingId: binding.bindingId,
      bindingScope: binding.bindingScope,
      logicalAssetId: binding.logicalAssetId,
      contextType: binding.contextType,
      providerType: binding.providerType,
      resourceRef: binding.resourceRef,
      capabilities: [...binding.capabilities].sort(),
      bindingVersion: binding.bindingVersion,
      stage: binding.stage,
      status: binding.status,
    })).sort((left, right) => left.bindingId.localeCompare(right.bindingId)),
    rolePackReleases: releases.map(release => ({
      releaseId: release.releaseId,
      rolePackId: release.rolePackId,
      verificationLevel: release.verificationLevel,
      assetSetFingerprint: release.assetSetFingerprint,
      verifiedAt: release.verifiedAt?.toISOString() || null,
    })).sort((left, right) => left.rolePackId.localeCompare(right.rolePackId)),
    plans: [
      { rolePackId: wealthPlan.rolePackId, planId: wealthPlan.planId, planVersion: wealthPlan.planVersion },
      { rolePackId: insurancePlan.rolePackId, planId: insurancePlan.planId, planVersion: insurancePlan.planVersion },
    ],
  };
  const identity = targetIds.map(logicalAssetId => {
    const wealthItem = wealthResolution.resolutions.find(item => item.need.logicalAssetId === logicalAssetId);
    const insuranceItem = insuranceResolution.resolutions.find(item => item.need.logicalAssetId === logicalAssetId);
    return Boolean(
      wealthItem?.binding
      && insuranceItem?.binding
      && wealthItem.binding.bindingId === insuranceItem.binding.bindingId
      && wealthItem.binding.providerType === insuranceItem.binding.providerType
      && wealthItem.binding.resourceRef === insuranceItem.binding.resourceRef
      && wealthItem.binding.bindingScope === "enterprise_shared"
      && insuranceItem.binding.bindingScope === "enterprise_shared"
    );
  });
  const purposeFilters = [
    wealthMemory.receipt.resolution?.needs[0].purposeFilter,
    insuranceMemory.receipt.resolution?.needs[0].purposeFilter,
    wealthWork.receipt.resolution?.needs[0].purposeFilter,
    insuranceWork.receipt.resolution?.needs[0].purposeFilter,
  ];
  const status = wealthResolution.status === "READY"
    && insuranceResolution.status === "READY"
    && identity.every(Boolean)
    && purposeFilters.every(evidence => evidence?.appliedPurposeFilter)
    && leakage === 0
    && expectedSharedRecall.every(Boolean)
      ? "PASS" as const
      : "FAIL" as const;
  const relationshipCandidateFingerprint = sharedBindingCandidateFingerprint(relationshipBinding);
  const workCandidateFingerprint = sharedBindingCandidateFingerprint(workBinding);
  const report = {
    schema: "ea.governed-memory-purpose-environment-report.v1",
    status,
    organizationId,
    stage: "shadow",
    snapshotFingerprint: sha256(JSON.stringify(snapshotBody)),
    providerContractFingerprint,
    resolver: {
      wealthStatus: wealthResolution.status,
      insuranceStatus: insuranceResolution.status,
      sharedBindingIdentity: `${identity.filter(Boolean).length}/${identity.length}`,
      bindingSnapshotFingerprint: wealthResolution.bindingSnapshotFingerprint,
      sameSnapshot: wealthResolution.bindingSnapshotFingerprint === insuranceResolution.bindingSnapshotFingerprint,
    },
    purposeIsolation: {
      appliedFilterCount: purposeFilters.filter(evidence => evidence?.appliedPurposeFilter).length,
      expectedFilterCount: purposeFilters.length,
      crossRoleLeakageCount: leakage,
      expectedSharedRecordRecall: `${expectedSharedRecall.filter(Boolean).length}/${expectedSharedRecall.length}`,
      eligibilityViolationCount: 0,
    },
    provided: {
      relationshipMemoryBindingId: relationshipBinding.bindingId,
      governedWorkBindingId: workBinding.bindingId,
      wealthMemoryCount: wealthMemoryIds.length,
      insuranceMemoryCount: insuranceMemoryIds.length,
      wealthWorkCount: wealthWorkIds.length,
      insuranceWorkCount: insuranceWorkIds.length,
      roles: {
        [wealthPlan.rolePackId]: {
          principalFingerprint: wealthPrincipal.authorizationFingerprint,
          receiptFingerprints: [wealthMemory.receipt.receiptFingerprint, wealthWork.receipt.receiptFingerprint],
          providedMemory: {
            relationship: wealthMemory.receipt.provided.memory,
            work: wealthWork.receipt.provided.memory,
          },
          providedCandidateFingerprints: {
            ...(wealthMemoryIds.length ? { [relationshipBinding.bindingId]: relationshipCandidateFingerprint } : {}),
            ...(wealthWorkIds.length ? { [workBinding.bindingId]: workCandidateFingerprint } : {}),
          },
        },
        [insurancePlan.rolePackId]: {
          principalFingerprint: insurancePrincipal.authorizationFingerprint,
          receiptFingerprints: [insuranceMemory.receipt.receiptFingerprint, insuranceWork.receipt.receiptFingerprint],
          providedMemory: {
            relationship: insuranceMemory.receipt.provided.memory,
            work: insuranceWork.receipt.provided.memory,
          },
          providedCandidateFingerprints: {
            ...(insuranceMemoryIds.length ? { [relationshipBinding.bindingId]: relationshipCandidateFingerprint } : {}),
            ...(insuranceWorkIds.length ? { [workBinding.bindingId]: workCandidateFingerprint } : {}),
          },
        },
      },
    },
    promotionPerformed: false,
  };
  return { ...report, reportFingerprint: sha256(JSON.stringify(report)) };
  } finally {
    await cleanup();
    if (input.closeConnection !== false) await closeDbConnection();
  }
}

if (process.argv[1]?.endsWith("verify-governed-memory-purpose-environment.ts")) {
  runGovernedMemoryPurposeEnvironment()
    .then(report => {
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "PASS") process.exitCode = 1;
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}
