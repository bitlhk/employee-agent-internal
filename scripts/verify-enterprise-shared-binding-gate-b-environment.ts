import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { clawAdoptions } from "../drizzle/schema";
import type { ContextReceiptV1 } from "../shared/context-receipt";
import type {
  ConcreteContextPlanV1,
  ContextNeedPlanV1,
  ContextResolutionEvidenceV1,
  ContextSourceBindingV1,
} from "../shared/context-resolution";
import { runInsuranceRolePackControlledScenarios } from "../server/_core/insurance-role-pack-scenarios";
import { callInternalMcpTool, parseInternalMcpJsonResult } from "../server/_core/internal-mcp-client";
import { assertSharedBindingPromotionGate } from "../server/_core/context-resolution/shared-binding-promotion-gate";
import {
  assertSharedBindingValidationSnapshot,
  freezeSharedBindingValidationSnapshot,
  sharedBindingCandidateFingerprint,
  type SharedBindingValidationSnapshotV1,
} from "../server/_core/context-resolution/shared-binding-validation-snapshot";
import { resolveMcpBindingTarget } from "../server/_core/context-resolution/mcp-adapter";
import { resolveContextSources } from "../server/_core/context-resolution/source-resolver";
import { wealthContextNeedPlan } from "../server/_core/context-resolution/wealth-context-plans";
import { buildContextReceipt } from "../server/_core/governance/context-receipt";
import {
  governanceFingerprint,
  principalFingerprint,
  type RuntimePrincipalV2,
} from "../server/_core/governance/contracts";
import { runWealthRolePackControlledScenarios } from "../server/_core/wealth-role-pack-scenarios";
import { listContextSourceBindingContracts } from "../server/db/context-source-bindings";
import { promoteShadowContextSourceBindings } from "../server/db/context-source-bindings";
import { closeDbConnection, getDb } from "../server/db/connection";
import { latestVerifiedRolePackReleases } from "../server/db/role-pack-releases";
import { resolveEffectiveRoleAssets } from "../server/db/role-assets";
import { runGovernedMemoryPurposeEnvironment } from "./verify-governed-memory-purpose-environment";

const SNAPSHOT_PATH = "examples/insurance-advisor-reference-role-pack/eval/shared-binding-validation-snapshot.v1.json";
const EXPECTED_SNAPSHOT = "ccf1a10b181bbf1955b3605a8bfc0d9772a91224e7a45e9c8da304181995cbc7";
const ORGANIZATION_ID = String(
  process.env.EA_DEMO_ORGANIZATION_ID || "org_linggan_finance",
).trim();
const TARGET_IDS = ["customer_profile", "customer_relationship_memory", "governed_work_state"] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function productionBindingId(logicalAssetId: string): string {
  return `ctxb_shared_production_${sha256(
    `${ORGANIZATION_ID}|enterprise_shared|${logicalAssetId}|production`,
  ).slice(0, 24)}`;
}

async function runtimePrincipal(roleTemplate: "wealth-manager" | "insurance-advisor"): Promise<RuntimePrincipalV2> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [adoption] = await db.select().from(clawAdoptions).where(and(
    eq(clawAdoptions.roleTemplate, roleTemplate),
    eq(clawAdoptions.status, "active"),
  )).orderBy(desc(clawAdoptions.updatedAt)).limit(1);
  if (!adoption) throw new Error(`GATE_B_ACTIVE_ADOPTION_MISSING:${roleTemplate}`);
  const effectiveAssets = await resolveEffectiveRoleAssets(roleTemplate);
  const authorizationFingerprint = governanceFingerprint({
    roleTemplate,
    skills: effectiveAssets.skills,
    mcpServers: effectiveAssets.mcpServers,
  });
  const authorizationSnapshotId = `gate-b-${roleTemplate}-${authorizationFingerprint.slice(0, 12)}`;
  return {
    tenantId: "tn-role-scale-shadow",
    organizationId: ORGANIZATION_ID,
    userId: adoption.userId,
    adoptionId: adoption.adoptId,
    agentId: adoption.agentId,
    roleTemplate,
    workspaceId: `/shadow/${ORGANIZATION_ID}/${roleTemplate}`,
    permissionProfile: adoption.permissionProfile,
    sessionId: `gate-b-${roleTemplate}-${Date.now()}`,
    authorizationSnapshotId,
    authorizationFingerprint,
    identityVersion: "2",
  };
}

function resolutionEvidence(plan: ConcreteContextPlanV1): ContextResolutionEvidenceV1 {
  return {
    schema: "ea.context-resolution-evidence.v1",
    planId: plan.planId,
    planVersion: plan.planVersion,
    taskId: plan.taskId,
    status: plan.status,
    needs: plan.resolutions.map(item => ({
      logicalAssetId: item.need.logicalAssetId,
      contextType: item.need.contextType,
      requiredness: item.need.requiredness,
      resolutionStatus: item.status,
      ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}),
      ...(item.binding ? {
        bindingId: item.binding.bindingId,
        bindingScope: item.binding.bindingScope,
        bindingVersion: item.binding.bindingVersion,
        providerType: item.binding.providerType,
        resourceRefFingerprint: governanceFingerprint(item.binding.resourceRef),
        rolePackId: plan.rolePackId,
        purpose: item.need.purpose,
      } : {}),
    })),
    bindingSnapshotFingerprint: plan.bindingSnapshotFingerprint,
    resolutionFingerprint: plan.resolutionFingerprint,
  };
}

function firstCustomerId(value: unknown): string | null {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }
    const row = current as Record<string, unknown>;
    const id = row.customerId ?? row.customer_id ?? row.customerCode ?? row.customer_code ?? row.id;
    if (typeof id === "string" || typeof id === "number") return String(id);
    for (const key of ["data", "customers", "items", "records", "rows", "list", "result"]) {
      if (key in row) queue.push(row[key]);
    }
  }
  return null;
}

async function wealthCustomerId(principal: RuntimePrincipalV2): Promise<string> {
  const endpointUrl = String(
    process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp",
  ).trim();
  const list = parseInternalMcpJsonResult(await callInternalMcpTool({
    endpointUrl,
    toolName: "wealth_assistant_customer_list",
    args: { page: 1, pageSize: 1 },
    agentId: principal.agentId,
    adoptId: principal.adoptionId,
    sessionId: principal.sessionId,
    timeoutMs: 30_000,
  }));
  const customerId = firstCustomerId(list);
  if (!customerId) throw new Error("CUSTOMER_PROFILE_EMPTY");
  return customerId;
}

async function retrieveCustomerProfile(input: {
  principal: RuntimePrincipalV2;
  binding: ContextSourceBindingV1;
}): Promise<{ source: ContextReceiptV1["provided"]["businessData"][number] | null; error?: string }> {
  try {
    const target = resolveMcpBindingTarget(input.binding);
    const customerId = input.principal.roleTemplate === "wealth-manager"
      ? await wealthCustomerId(input.principal)
      : String(process.env.EA_GATE_B_INSURANCE_CUSTOMER_ID || "1").trim();
    const result = await callInternalMcpTool({
      endpointUrl: target.endpointUrl,
      toolName: target.toolName,
      args: {
        customer_id: customerId,
        task_id: input.principal.roleTemplate === "wealth-manager" ? "WM-GT-01" : "IA-GT-01",
      },
      agentId: input.principal.agentId,
      adoptId: input.principal.adoptionId,
      sessionId: input.principal.sessionId,
      timeoutMs: 30_000,
    });
    const projection = parseInternalMcpJsonResult(result);
    const meta = result._meta && typeof result._meta === "object"
      ? result._meta as Record<string, unknown>
      : {};
    const receipt = meta.eaContextReceipt as ContextReceiptV1 | undefined;
    const source = receipt?.provided.businessData.find(item => (
      item.bindingId === input.binding.bindingId
      && item.candidateBindingFingerprint === sharedBindingCandidateFingerprint(input.binding)
    )) || null;
    if (!source) {
      const reasons = Array.isArray(projection.reasonCodes)
        ? projection.reasonCodes.map(String).join(",")
        : "CUSTOMER_PROFILE_NOT_PROVIDED";
      return { source: null, error: reasons };
    }
    return { source };
  } catch (error) {
    return { source: null, error: errorMessage(error) };
  }
}

function candidateFingerprints(receipt: ContextReceiptV1): Record<string, string> {
  const rows = [...receipt.provided.businessData, ...receipt.provided.memory];
  return Object.fromEntries(rows
    .filter(row => row.bindingId && row.candidateBindingFingerprint)
    .map(row => [row.bindingId as string, row.candidateBindingFingerprint as string]));
}

function fullPlan(input: {
  rolePackId: string;
  roleTemplate: string;
  taskId: string;
  planId: string;
  bindings: ContextSourceBindingV1[];
}): ConcreteContextPlanV1 {
  const definitions = new Map(input.bindings.map(binding => [binding.logicalAssetId, binding]));
  const plan: ContextNeedPlanV1 = {
    schema: "ea.context-need-plan.v1",
    planId: input.planId,
    planVersion: "1.0.0",
    rolePackId: input.rolePackId,
    roleTemplate: input.roleTemplate,
    taskId: input.taskId,
    needs: TARGET_IDS.map(logicalAssetId => {
      const binding = definitions.get(logicalAssetId);
      if (!binding) throw new Error(`GATE_B_BINDING_MISSING:${logicalAssetId}`);
      return {
        needId: `gate-b-${logicalAssetId}`,
        logicalAssetId,
        contextType: binding.contextType,
        requiredness: "required" as const,
        purpose: `${input.roleTemplate} Gate B ${logicalAssetId}`,
        freshness: { mode: "latest" as const },
        requiredCapabilities: logicalAssetId === "customer_profile"
          ? ["point_read"]
          : ["relevant_retrieval", "purpose_filter"],
      };
    }),
  };
  return resolveContextSources({ plan, bindings: input.bindings, organizationId: ORGANIZATION_ID, stage: "shadow" });
}

function exactBindingSemantics(bindings: ContextSourceBindingV1[]): boolean {
  const shared = bindings.find(binding => binding.logicalAssetId === "customer_profile");
  if (!shared) return false;
  const plan: ContextNeedPlanV1 = {
    schema: "ea.context-need-plan.v1",
    planId: "gate-b.exact-semantics",
    planVersion: "1",
    rolePackId: "linggan-insurance.insurance-advisor",
    roleTemplate: "insurance-advisor",
    taskId: "IA-GT-01",
    needs: [{
      needId: "profile",
      logicalAssetId: "customer_profile",
      contextType: "business_data",
      requiredness: "required",
      purpose: "验证 Exact Binding 不回退 Shared",
      freshness: { mode: "latest" },
      requiredCapabilities: ["point_read"],
    }],
  };
  const exact: ContextSourceBindingV1 = {
    ...shared,
    bindingId: "ctxb-gate-b-exact-disabled",
    bindingScope: "role_pack",
    rolePackId: plan.rolePackId,
    status: "disabled",
  };
  const disabled = resolveContextSources({ plan, bindings: [shared, exact], organizationId: ORGANIZATION_ID, stage: "shadow" });
  const mismatch = resolveContextSources({
    plan,
    bindings: [shared, { ...exact, bindingId: "ctxb-gate-b-exact-mismatch", status: "active", capabilities: [] }],
    organizationId: ORGANIZATION_ID,
    stage: "shadow",
  });
  return disabled.resolutions[0]?.reasonCode === "EXACT_BINDING_DISABLED"
    && mismatch.resolutions[0]?.reasonCode === "EXACT_BINDING_CAPABILITY_MISMATCH";
}

async function main() {
  const frozen = assertSharedBindingValidationSnapshot(
    JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as SharedBindingValidationSnapshotV1,
    EXPECTED_SNAPSHOT,
  );
  const [wealthPrincipal, insurancePrincipal] = await Promise.all([
    runtimePrincipal("wealth-manager"),
    runtimePrincipal("insurance-advisor"),
  ]);
  const authorizationFingerprints = {
    "linggan-bank.wealth-manager": wealthPrincipal.authorizationFingerprint,
    "linggan-insurance.insurance-advisor": insurancePrincipal.authorizationFingerprint,
  };
  const gateValidationSnapshotFingerprint = governanceFingerprint({
    contextSnapshotFingerprint: frozen.snapshotFingerprint,
    authorizationFingerprints,
  });
  const bindings = await listContextSourceBindingContracts({
    organizationId: ORGANIZATION_ID,
    rolePackId: "linggan-insurance.insurance-advisor",
    stage: "shadow",
  });
  const candidates = bindings.filter(binding => TARGET_IDS.includes(binding.logicalAssetId as typeof TARGET_IDS[number]));
  const releases = await latestVerifiedRolePackReleases(frozen.rolePackReleases.map(release => release.rolePackId));
  const providerFiles = [
    "shared/customer-profile-contract.ts",
    "server/_core/customer-profile-provider.ts",
    "server/_core/customer-profile-mcp.ts",
    "shared/memory-purpose.ts",
    "server/_core/agent-memory-retrieval.ts",
    "server/_core/context-resolution/governed-memory-provider.ts",
    "server/_core/governed-work-continuity.ts",
  ];
  const currentSnapshot = freezeSharedBindingValidationSnapshot({
    schema: "ea.shared-binding-validation-snapshot.v1",
    organizationId: ORGANIZATION_ID,
    stage: "shadow",
    providerContractFingerprint: sha256(providerFiles.map(file => `${file}:${sha256(readFileSync(file))}`).join("\n")),
    bindings: candidates,
    rolePackReleases: releases.map(release => ({
      releaseId: release.releaseId,
      rolePackId: release.rolePackId,
      verificationLevel: release.verificationLevel,
      assetSetFingerprint: release.assetSetFingerprint,
      verifiedAt: release.verifiedAt?.toISOString() || null,
    })),
    plans: frozen.plans,
  });
  const snapshotIntegrityPassed = currentSnapshot.snapshotFingerprint === frozen.snapshotFingerprint;

  const purpose = await runGovernedMemoryPurposeEnvironment({
    closeConnection: false,
    principals: { wealth: wealthPrincipal, insurance: insurancePrincipal },
  });
  const profileBinding = candidates.find(binding => binding.logicalAssetId === "customer_profile");
  if (!profileBinding) throw new Error("GATE_B_CUSTOMER_PROFILE_BINDING_MISSING");
  const [wealthProfile, insuranceProfile, wealthGolden, insuranceGolden] = await Promise.all([
    retrieveCustomerProfile({ principal: wealthPrincipal, binding: profileBinding }),
    retrieveCustomerProfile({ principal: insurancePrincipal, binding: profileBinding }),
    runWealthRolePackControlledScenarios(),
    runInsuranceRolePackControlledScenarios(),
  ]);
  const roleInputs = [
    {
      rolePackId: "linggan-bank.wealth-manager",
      roleTemplate: "wealth-manager",
      taskId: "WM-GT-01",
      principal: wealthPrincipal,
      profile: wealthProfile,
      golden: wealthGolden,
    },
    {
      rolePackId: "linggan-insurance.insurance-advisor",
      roleTemplate: "insurance-advisor",
      taskId: "IA-GT-01",
      principal: insurancePrincipal,
      profile: insuranceProfile,
      golden: insuranceGolden,
    },
  ];
  const receipts = roleInputs.map(role => {
    const plan = fullPlan({
      rolePackId: role.rolePackId,
      roleTemplate: role.roleTemplate,
      taskId: role.taskId,
      planId: frozen.plans.find(item => item.rolePackId === role.rolePackId)?.planId || `gate-b.${role.rolePackId}`,
      bindings: candidates,
    });
    const memoryEvidence = purpose.provided.roles[role.rolePackId as keyof typeof purpose.provided.roles];
    const relationshipBinding = candidates.find(binding => binding.logicalAssetId === "customer_relationship_memory")!;
    const workBinding = candidates.find(binding => binding.logicalAssetId === "governed_work_state")!;
    const withBinding = (
      items: ContextReceiptV1["provided"]["memory"],
      binding: ContextSourceBindingV1,
    ): ContextReceiptV1["provided"]["memory"] => items.map(item => ({
      ...item,
      logicalAssetId: binding.logicalAssetId,
      bindingId: binding.bindingId,
      providerType: binding.providerType,
      resourceRefFingerprint: governanceFingerprint(binding.resourceRef),
      candidateBindingFingerprint: sharedBindingCandidateFingerprint(binding),
    }));
    const memory = [
      ...withBinding(memoryEvidence.providedMemory.relationship, relationshipBinding),
      ...withBinding(memoryEvidence.providedMemory.work, workBinding),
    ];
    const receipt = buildContextReceipt({
      taskId: role.taskId,
      taskLabel: `${role.roleTemplate} Shared Binding Gate B`,
      principalFingerprint: principalFingerprint(role.principal),
      resolution: resolutionEvidence(plan),
      provided: {
        knowledge: [],
        businessData: role.profile.source ? [role.profile.source] : [],
        memory,
        capabilities: [],
      },
      excluded: role.profile.error ? [{
        category: "business_data",
        reasonCode: "CUSTOMER_PROFILE_NOT_PROVIDED",
        count: 1,
        message: role.profile.error,
        disclosure: "aggregate_only",
      }] : [],
      readiness: {
        status: role.profile.source && memory.length ? "READY" : "BLOCKED",
        requestedOutcome: "validate_enterprise_shared_context_consumption",
        allowedOutcomes: role.profile.source && memory.length ? ["gate_b_candidate_provided"] : [],
        deniedOutcomes: role.profile.source && memory.length ? [] : ["promote_enterprise_shared_binding"],
        reasons: role.profile.error ? [role.profile.error] : [],
        remediation: role.profile.error ? ["恢复 Customer Provider 并完成岗位授权后重新验证"] : [],
        decisionFingerprint: governanceFingerprint({
          rolePackId: role.rolePackId,
          gateValidationSnapshotFingerprint,
        }),
      },
    });
    return { role, plan, receipt, providedCandidateFingerprints: candidateFingerprints(receipt) };
  });

  const expectedBindingIds = candidates.map(binding => binding.bindingId);
  const releaseByRole = new Map(frozen.rolePackReleases.map(release => [release.rolePackId, release]));
  const validation = {
    schema: "ea.shared-binding-promotion-validation.v1" as const,
    validationSnapshotFingerprint: gateValidationSnapshotFingerprint,
    expectedBindingIds,
    sharedBindingIdentityCount: purpose.resolver.sharedBindingIdentity === "3/3" ? 3 : 0,
    expectedSharedBindingIdentityCount: 3,
    purposeIsolationPassed: purpose.status === "PASS" && purpose.purposeIsolation.crossRoleLeakageCount === 0,
    eligibilityViolationCount: purpose.purposeIsolation.eligibilityViolationCount,
    roleValidations: receipts.map(({ role, receipt, providedCandidateFingerprints }) => ({
      rolePackId: role.rolePackId,
      verifiedReleaseId: releaseByRole.get(role.rolePackId)?.releaseId || "",
      goldenTaskPassed: role.golden.status === "PASS",
      validationSnapshotFingerprint: gateValidationSnapshotFingerprint,
      goldenTaskReportFingerprint: governanceFingerprint(role.golden),
      providedCandidateFingerprints,
      receiptFingerprint: receipt.receiptFingerprint,
    })),
  };
  let gateError: string | null = null;
  let gateFingerprint: string | null = null;
  try {
    if (!snapshotIntegrityPassed) throw new Error("SHARED_BINDING_SNAPSHOT_INTEGRITY_FAILED");
    gateFingerprint = assertSharedBindingPromotionGate(validation, candidates).validationFingerprint;
  } catch (error) {
    gateError = errorMessage(error);
  }
  const promote = process.argv.includes("--promote");
  const promotionReviewApproved = process.argv.includes(
    "--promotion-review-approved",
  );
  let promotedBindings: Array<{ bindingId: string; logicalAssetId: string }> = [];
  if (promote) {
    if (!promotionReviewApproved)
      throw new Error("SHARED_BINDING_PROMOTION_REVIEW_REQUIRED");
    if (gateError || !gateFingerprint)
      throw new Error(`SHARED_BINDING_PROMOTION_GATE_BLOCKED:${gateError || "UNKNOWN"}`);
    const rows = await promoteShadowContextSourceBindings({
      bindings: candidates.map(binding => ({
        shadowBindingId: binding.bindingId,
        productionBindingId: productionBindingId(binding.logicalAssetId),
      })),
      sharedValidation: validation,
      actor: "enterprise-shared-binding-promotion-review",
      promotionId: `ctxp_gate_b_${gateFingerprint.slice(0, 24)}`,
    });
    promotedBindings = rows
      .map(row => ({ bindingId: row.bindingId, logicalAssetId: row.logicalAssetId }))
      .sort((left, right) => left.logicalAssetId.localeCompare(right.logicalAssetId));
  }
  const report = {
    schema: "ea.enterprise-shared-binding-gate-b-environment-report.v1",
    status: gateError ? "BLOCKED" as const : "PASS" as const,
    organizationId: ORGANIZATION_ID,
    stage: "shadow" as const,
    contextSnapshotFingerprint: frozen.snapshotFingerprint,
    validationSnapshotFingerprint: gateValidationSnapshotFingerprint,
    authorizationFingerprints,
    snapshotIntegrity: snapshotIntegrityPassed ? "PASS" as const : "FAIL" as const,
    sharedBindingIdentity: purpose.resolver.sharedBindingIdentity,
    purposeIsolation: purpose.status,
    eligibilityViolationCount: purpose.purposeIsolation.eligibilityViolationCount,
    crossRoleLeakageCount: purpose.purposeIsolation.crossRoleLeakageCount,
    exactBindingSemantics: exactBindingSemantics(candidates) ? "PASS" as const : "FAIL" as const,
    wealthGoldenTasks: wealthGolden.status,
    insuranceGoldenTasks: insuranceGolden.status,
    candidateProvided: Object.fromEntries(receipts.map(item => [item.role.rolePackId, {
      count: Object.keys(item.providedCandidateFingerprints).length,
      expected: expectedBindingIds.length,
      bindingIds: Object.keys(item.providedCandidateFingerprints).sort(),
      receiptFingerprint: item.receipt.receiptFingerprint,
    }])),
    customerProfile: {
      wealth: wealthProfile.source ? "PROVIDED" : "BLOCKED",
      insurance: insuranceProfile.source ? "PROVIDED" : "BLOCKED",
      wealthReason: wealthProfile.error || null,
      insuranceReason: insuranceProfile.error || null,
    },
    gateFingerprint,
    gateError,
    promotionPerformed: promotedBindings.length > 0,
    promotedBindings,
  };
  return { ...report, reportFingerprint: governanceFingerprint(report) };
}

main()
  .then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
