import type { ContextNeedPlanV1, ContextSourceBindingV1 } from "../shared/context-resolution";
import {
  ENTERPRISE_SHARED_SHADOW_CONTEXTS,
  verifyEnterpriseSharedBindingShadow,
} from "../server/_core/context-resolution/enterprise-shared-binding-shadow";

const organizationId = "grace-shadow-validation";
const definitions = {
  customer_profile: { contextType: "business_data", providerType: "mcp", resourceRef: "mcp://enterprise/customer-profile", capabilities: ["point_read"] },
  customer_relationship_memory: { contextType: "memory", providerType: "api", resourceRef: "api://employee-agent/agent-memory/relevant", capabilities: ["relevant_retrieval", "purpose_filter"] },
  governed_work_state: { contextType: "memory", providerType: "api", resourceRef: "api://employee-agent/governed-work-items", capabilities: ["relevant_retrieval", "purpose_filter"] },
} as const;

function plan(rolePackId: string, roleTemplate: string, taskId: string): ContextNeedPlanV1 {
  return {
    schema: "ea.context-need-plan.v1",
    planId: `${rolePackId}.shared-binding-shadow`,
    planVersion: "1.0.0",
    rolePackId,
    roleTemplate,
    taskId,
    needs: ENTERPRISE_SHARED_SHADOW_CONTEXTS.map(logicalAssetId => ({
      needId: logicalAssetId,
      logicalAssetId,
      contextType: definitions[logicalAssetId].contextType,
      requiredness: "required",
      purpose: `${roleTemplate} authorized purpose for ${logicalAssetId}`,
      freshness: { mode: "latest" },
      requiredCapabilities: [...definitions[logicalAssetId].capabilities],
    })),
  };
}

const bindings: ContextSourceBindingV1[] = ENTERPRISE_SHARED_SHADOW_CONTEXTS.map(logicalAssetId => ({
  schema: "ea.context-source-binding.v1",
  bindingId: `ctxb-shadow-shared-${logicalAssetId}`,
  organizationId,
  rolePackId: "*",
  bindingScope: "enterprise_shared",
  logicalAssetId,
  contextType: definitions[logicalAssetId].contextType,
  providerType: definitions[logicalAssetId].providerType,
  resourceRef: definitions[logicalAssetId].resourceRef,
  capabilities: [...definitions[logicalAssetId].capabilities],
  bindingVersion: "shadow-v1",
  stage: "shadow",
  status: "active",
}));

function consumer(rolePackId: string, roleTemplate: string, taskId: string, marker: string) {
  return {
    plan: plan(rolePackId, roleTemplate, taskId),
    principalFingerprint: marker.repeat(64),
    eligibility: ENTERPRISE_SHARED_SHADOW_CONTEXTS.map(logicalAssetId => ({
      logicalAssetId,
      eligibilityScopeFingerprint: `${marker}-${logicalAssetId}`.padEnd(64, "0").slice(0, 64),
      providedItemFingerprints: [`${marker}-provided-${logicalAssetId}`],
      deniedItemFingerprints: [`${marker}-denied-${logicalAssetId}`],
    })),
  };
}

const report = verifyEnterpriseSharedBindingShadow({
  organizationId,
  bindings,
  consumers: [
    consumer("linggan-bank.wealth-manager", "wealth-manager", "WM-GT-01", "a"),
    consumer("linggan-insurance.insurance-advisor", "insurance-advisor", "IA-GT-01", "b"),
  ],
});

console.log(JSON.stringify({ evidenceMode: "engineering_fixture", ...report }, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
