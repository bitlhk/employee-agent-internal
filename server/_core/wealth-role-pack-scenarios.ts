import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from "../db";
import { buildKnowledgeEligibility } from "./knowledge-eligibility";
import { runWealthRolePackContractChecks } from "./reference-role-pack-contracts";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import { prepareWealthAllocationContext, type WealthAllocationDependencies } from "./wealth-allocation-context";
import { prepareWealthPrevisitContext } from "./wealth-previsit-context";
import { selectWealthPolicyDocument } from "./wealth-policy-selection";

type ScenarioCheck = { assertion: string; passed: boolean; actual?: unknown };
type ScenarioResult = {
  scenarioId: string;
  taskId: "WM-GT-01" | "WM-GT-03" | "WM-GT-04";
  status: "PASS" | "FAIL";
  checks: ScenarioCheck[];
  error?: string;
};

const NOW = new Date("2026-08-13T00:00:00.000Z");
const principal = {
  tenantId: "tn_controlled_fixture",
  organizationId: "org_controlled_fixture",
  userId: 7,
  adoptionId: "lgj-controlled-fixture",
  agentId: "agent-controlled-fixture",
  roleTemplate: "wealth-manager",
  workspaceId: "/tmp/controlled-fixture",
  permissionProfile: "internal",
  authorizationSnapshotId: "authz_controlled_fixture",
  authorizationFingerprint: "a".repeat(64),
  sessionId: "session-controlled-fixture",
  identityVersion: "2",
} satisfies RuntimePrincipalV2;

function check(assertion: string, passed: boolean, actual?: unknown): ScenarioCheck {
  return { assertion, passed, ...(passed || actual === undefined ? {} : { actual }) };
}

async function runScenario(
  scenarioId: string,
  taskId: ScenarioResult["taskId"],
  execute: () => Promise<ScenarioCheck[]>,
): Promise<ScenarioResult> {
  try {
    const checks = await execute();
    return { scenarioId, taskId, status: checks.every((item) => item.passed) ? "PASS" : "FAIL", checks };
  } catch (error) {
    return {
      scenarioId,
      taskId,
      status: "FAIL",
      checks: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function knowledgeBasis(status: "ready" | "unavailable") {
  return {
    status,
    evaluatedAt: NOW.toISOString(),
    selected: status === "ready" ? {
      sourceAssetId: "wm-previsit-sop",
      documentId: "doc_previsit_v1",
      versionLabel: "V1.0",
      contentHash: "b".repeat(64),
      sourceDepartment: "财富管理部",
    } : null,
    eligibilityFingerprint: "c".repeat(64),
    userMessage: status === "ready" ? "当前访前作业依据已就绪。" : "当前访前作业依据不可用。",
  } as const;
}

function policyBase(): KnowledgeBaseRecord {
  return {
    id: 1, publicId: "kb_wealth_controlled", ownerUserId: 1, ownerGroupId: 3,
    scope: "role", isGlobal: false, roleTemplate: "wealth-manager", name: "财富经理岗位知识",
    description: "", classification: "internal", externalProcessingAllowed: true, status: "ready",
    documentCount: 2, chunkCount: 2, lastError: null, indexVersion: "v1", indexSchemaVersion: 1,
    indexedAt: NOW.toISOString(), createdAt: "2026-07-01T00:00:00.000Z", updatedAt: NOW.toISOString(),
  };
}

function policyDocument(input: {
  publicId: string;
  name: string;
  versionLabel: string;
  lifecycle?: KnowledgeDocumentRecord["lifecycle"];
  effectiveAt: string;
  expiresAt?: string | null;
}): KnowledgeDocumentRecord {
  return {
    id: input.publicId.endsWith("22") ? 22 : 21,
    publicId: input.publicId,
    knowledgeBaseId: 1,
    name: input.name,
    extension: ".md",
    mimeType: "text/markdown",
    storagePath: `/controlled/${input.name}`,
    sizeBytes: 100,
    sha256: input.publicId.endsWith("22") ? "d".repeat(64) : "e".repeat(64),
    sourceAssetId: input.publicId,
    documentSeriesId: "wealth-suitability-policy",
    supersedesDocumentId: input.publicId.endsWith("22") ? "doc_policy_v21" : null,
    versionLabel: input.versionLabel,
    lifecycle: input.lifecycle || "active",
    sourceDepartment: "财富管理部",
    classification: "internal",
    authority: "approved",
    externalProcessingAllowed: true,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt ?? null,
    status: "ready",
    chunkCount: 1,
    lastError: null,
    parserVersion: "v1",
    indexVersion: "v1",
    createdAt: input.effectiveAt,
    updatedAt: NOW.toISOString(),
  };
}

const customerPayload = {
  customer: {
    customerId: "C-DEMO-001",
    name: "演示客户",
    riskLevel: "C3",
    assessmentStatus: "valid",
    assessmentExpiresAt: "2027-01-01T00:00:00.000Z",
    dataAsOf: NOW.toISOString(),
  },
};

const productPayload = {
  updatedAt: NOW.toISOString(),
  products: [
    { productId: "P-R2", name: "稳健固收", riskLevel: "R2", status: "on_sale", channels: ["branch"], dataAsOf: NOW.toISOString() },
    { productId: "P-R4", name: "高风险权益", riskLevel: "R4", status: "on_sale", channels: ["branch"], dataAsOf: NOW.toISOString() },
  ],
};

function allocationDependencies(patch: Partial<WealthAllocationDependencies> = {}): WealthAllocationDependencies {
  return {
    loadCustomer: async () => customerPayload,
    searchProducts: async () => productPayload,
    resolvePolicySource: async () => ({
      ready: true,
      sourceAssetId: "wm-suitability-policy-v22",
      versionLabel: "V2.2",
      sourceLocator: "4.1 风险等级匹配",
      eligibilityFingerprint: "f".repeat(64),
    }),
    ...patch,
  };
}

async function allocation(dependencies: WealthAllocationDependencies) {
  return prepareWealthAllocationContext({
    principal,
    request: {
      customerId: "C-DEMO-001",
      amount: 500_000,
      horizonMonths: 36,
      channel: "branch",
      keyword: "",
      productType: "",
      maxProducts: 10,
    },
    dependencies,
    now: NOW,
  });
}

export async function runWealthRolePackControlledScenarios(root = process.cwd()) {
  const contract = runWealthRolePackContractChecks(root);
  const currentPolicyName = "15-财富产品适当性销售管理细则（V2.2现行）.md";
  const currentPolicy = policyDocument({
    publicId: "doc_policy_v22", name: currentPolicyName, versionLabel: "V2.2",
    effectiveAt: "2026-07-01T00:00:00.000Z",
  });
  const historicalPolicy = policyDocument({
    publicId: "doc_policy_v21", name: "15-财富产品适当性销售管理细则（V2.1历史）.md", versionLabel: "V2.1",
    lifecycle: "expired", effectiveAt: "2025-07-01T00:00:00.000Z", expiresAt: "2026-06-30T23:59:59.000Z",
  });

  const scenarios = await Promise.all([
    runScenario("WM-GT-01-CONTROLLED-NORMAL", "WM-GT-01", async () => {
      const result = await prepareWealthPrevisitContext({
        principal,
        customerId: "C-DEMO-001",
        dependencies: {
          probeIdentity: async () => ({ allowed: true }),
          loadCustomer: async () => customerPayload,
          resolveKnowledge: async () => knowledgeBasis("ready"),
        },
      });
      return [
        check("customer_scope_verified", result.evidence.scopeVerified),
        check("customer_data_as_of_present", Boolean(result.evidence.customerDataAsOf)),
        check("eligible_previsit_knowledge_selected", result.knowledgeBasis.selected?.sourceAssetId === "wm-previsit-sop"),
      ];
    }),
    runScenario("WM-GT-01-CONTROLLED-CROSS-OWNER", "WM-GT-01", async () => {
      let denied = false;
      try {
        await prepareWealthPrevisitContext({
          principal,
          customerId: "C-DEMO-001",
          dependencies: {
            probeIdentity: async () => ({ allowed: true }),
            loadCustomer: async () => ({ customer: { customerId: "C-OTHER" } }),
            resolveKnowledge: async () => knowledgeBasis("ready"),
          },
        });
      } catch (error) {
        denied = /客户标识/u.test(error instanceof Error ? error.message : String(error));
      }
      return [check("cross_owner_customer_is_denied", denied)];
    }),
    runScenario("WM-GT-01-CONTROLLED-KNOWLEDGE-DEGRADED", "WM-GT-01", async () => {
      const result = await prepareWealthPrevisitContext({
        principal,
        customerId: "C-DEMO-001",
        dependencies: {
          probeIdentity: async () => ({ allowed: true }),
          loadCustomer: async () => customerPayload,
          resolveKnowledge: async () => knowledgeBasis("unavailable"),
        },
      });
      return [
        check("expired_or_missing_knowledge_degrades_task", result.status === "degraded"),
        check("verified_customer_facts_are_retained", result.customer.customerId === "C-DEMO-001"),
      ];
    }),
    runScenario("WM-GT-03-CONTROLLED-CURRENT-POLICY", "WM-GT-03", async () => {
      const documents = [currentPolicy, historicalPolicy];
      const eligibility = buildKnowledgeEligibility({
        bases: [policyBase()], documents, userId: 7, actorRole: "user", roleTemplate: "wealth-manager", now: NOW,
      });
      const selected = selectWealthPolicyDocument({
        documents, eligibleDocumentIds: eligibility.documentIds, configuredName: currentPolicyName,
      }).selected;
      return [
        check("current_policy_is_selected", selected?.versionLabel === "V2.2"),
        check("historical_policy_is_filtered", !eligibility.documentIds.includes("doc_policy_v21")),
        check("eligibility_fingerprint_is_present", eligibility.fingerprint.length === 64),
      ];
    }),
    runScenario("WM-GT-03-CONTROLLED-NO-CURRENT", "WM-GT-03", async () => {
      const expiredCurrent = { ...currentPolicy, lifecycle: "expired" as const, expiresAt: "2026-08-01T00:00:00.000Z" };
      const documents = [expiredCurrent, historicalPolicy];
      const eligibility = buildKnowledgeEligibility({
        bases: [policyBase()], documents, userId: 7, actorRole: "user", roleTemplate: "wealth-manager", now: NOW,
      });
      const selected = selectWealthPolicyDocument({
        documents, eligibleDocumentIds: eligibility.documentIds, configuredName: currentPolicyName,
      }).selected;
      return [check("enterprise_policy_fails_closed_without_current_version", selected === undefined)];
    }),
    runScenario("WM-GT-04-CONTROLLED-RISK-MISMATCH", "WM-GT-04", async () => {
      const result = await allocation(allocationDependencies());
      return [
        check("eligible_product_set_excludes_r4", result.eligibleProducts.every((item) => item.productId !== "P-R4")),
        check("risk_mismatch_policy_denial_is_recorded", result.evidence.decisions.some((item) => item.policyCode.endsWith("RISK_MISMATCH"))),
      ];
    }),
    runScenario("WM-GT-04-CONTROLLED-ASSESSMENT-EXPIRED", "WM-GT-04", async () => {
      const result = await allocation(allocationDependencies({
        loadCustomer: async () => ({
          customer: { ...customerPayload.customer, assessmentExpiresAt: "2026-08-01T00:00:00.000Z" },
        }),
      }));
      return [
        check("expired_assessment_has_no_formal_candidates", result.eligibleProducts.length === 0),
        check("assessment_expiry_policy_denial_is_recorded", result.evidence.decisions.every((item) => item.policyCode.endsWith("ASSESSMENT_EXPIRED"))),
      ];
    }),
    runScenario("WM-GT-04-CONTROLLED-POLICY-UNAVAILABLE", "WM-GT-04", async () => {
      const result = await allocation(allocationDependencies({
        resolvePolicySource: async () => ({
          ready: false, sourceAssetId: "", versionLabel: "", sourceLocator: "", eligibilityFingerprint: "0".repeat(64),
        }),
      }));
      return [
        check("missing_policy_has_no_formal_candidates", result.eligibleProducts.length === 0),
        check("policy_unavailable_fails_closed", result.evidence.decisions.every((item) => item.policyCode.endsWith("POLICY_SOURCE_UNAVAILABLE"))),
      ];
    }),
  ]);
  const errors = [
    ...(contract.status === "PASS" ? [] : contract.errors.map((error) => `contract:${error}`)),
    ...scenarios.filter((scenario) => scenario.status === "FAIL").map((scenario) => `${scenario.scenarioId}:${scenario.error || "assertion failed"}`),
  ];
  return {
    schema: "ea.reference-role-pack-scenario-report.v1",
    status: errors.length ? "FAIL" as const : "PASS" as const,
    executionLevel: "controlled_scenario" as const,
    scenarioExecution: true,
    rolePackId: contract.rolePackId,
    releaseCandidateId: contract.releaseCandidateId,
    assetSetFingerprint: contract.assetSetFingerprint,
    evalSuiteVersion: "wm-golden-task-v1",
    taskIds: ["WM-GT-01", "WM-GT-03", "WM-GT-04"],
    scenarioCount: scenarios.length,
    passedScenarioCount: scenarios.filter((scenario) => scenario.status === "PASS").length,
    scenarios,
    errors,
  };
}
