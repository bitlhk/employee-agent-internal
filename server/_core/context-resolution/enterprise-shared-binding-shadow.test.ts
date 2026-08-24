import { describe, expect, it } from "vitest";
import type { ContextNeedPlanV1, ContextSourceBindingV1 } from "../../../shared/context-resolution";
import {
  ENTERPRISE_SHARED_SHADOW_CONTEXTS,
  verifyEnterpriseSharedBindingShadow,
} from "./enterprise-shared-binding-shadow";

const organizationId = "org-a";

function plan(rolePackId: string, roleTemplate: string): ContextNeedPlanV1 {
  const definitions = {
    customer_profile: ["business_data", ["point_read"]],
    customer_relationship_memory: ["memory", ["relevant_retrieval", "purpose_filter"]],
    governed_work_state: ["memory", ["relevant_retrieval", "purpose_filter"]],
  } as const;
  return {
    schema: "ea.context-need-plan.v1",
    planId: `${rolePackId}.shared-shadow`,
    planVersion: "1",
    rolePackId,
    roleTemplate,
    taskId: roleTemplate === "wealth-manager" ? "WM-GT-01" : "IA-GT-01",
    needs: ENTERPRISE_SHARED_SHADOW_CONTEXTS.map(logicalAssetId => ({
      needId: logicalAssetId,
      logicalAssetId,
      contextType: definitions[logicalAssetId][0],
      requiredness: "required",
      purpose: `${roleTemplate} purpose for ${logicalAssetId}`,
      freshness: { mode: "latest" },
      requiredCapabilities: [...definitions[logicalAssetId][1]],
    })),
  };
}

const bindings: ContextSourceBindingV1[] = [
  ["customer_profile", "business_data", "mcp", "mcp://enterprise/customer-profile", ["point_read"]],
  ["customer_relationship_memory", "memory", "api", "api://employee-agent/agent-memory/relevant", ["relevant_retrieval", "purpose_filter"]],
  ["governed_work_state", "memory", "api", "api://employee-agent/governed-work-items", ["relevant_retrieval", "purpose_filter"]],
].map(([logicalAssetId, contextType, providerType, resourceRef, capabilities]) => ({
  schema: "ea.context-source-binding.v1",
  bindingId: `ctxb-shared-${logicalAssetId}`,
  organizationId,
  rolePackId: "*",
  bindingScope: "enterprise_shared",
  logicalAssetId,
  contextType,
  providerType,
  resourceRef,
  capabilities,
  bindingVersion: "shadow-v1",
  stage: "shadow",
  status: "active",
})) as ContextSourceBindingV1[];

function consumer(rolePackId: string, roleTemplate: string, principal: string, prefix: string) {
  return {
    plan: plan(rolePackId, roleTemplate),
    principalFingerprint: principal.repeat(64),
    eligibility: ENTERPRISE_SHARED_SHADOW_CONTEXTS.map(logicalAssetId => ({
      logicalAssetId,
      eligibilityScopeFingerprint: `${prefix}-${logicalAssetId}`.padEnd(64, "0").slice(0, 64),
      providedItemFingerprints: [`${prefix}-allowed-${logicalAssetId}`],
      deniedItemFingerprints: [`${prefix}-denied-${logicalAssetId}`],
    })),
  };
}

describe("enterprise-shared Binding Shadow evidence", () => {
  it("proves 3/3 Binding identity while principals and Eligibility scopes differ", () => {
    const report = verifyEnterpriseSharedBindingShadow({
      organizationId,
      bindings,
      consumers: [
        consumer("linggan-bank.wealth-manager", "wealth-manager", "a", "wealth"),
        consumer("linggan-insurance.insurance-advisor", "insurance-advisor", "b", "insurance"),
      ],
    });
    expect(report).toMatchObject({
      status: "PASS",
      sharedBindingIdentityCount: 3,
      sharedBindingIdentityRate: 1,
      eligibilityViolationCount: 0,
    });
    expect(report.consumers[0].resolutions[0].principalFingerprint)
      .not.toBe(report.consumers[1].resolutions[0].principalFingerprint);
    expect(report.consumers[0].resolutions[0].eligibilityScopeFingerprint)
      .not.toBe(report.consumers[1].resolutions[0].eligibilityScopeFingerprint);
  });

  it("fails when denied Context appears in Provided Context", () => {
    const insurance = consumer("linggan-insurance.insurance-advisor", "insurance-advisor", "b", "insurance");
    insurance.eligibility[0].providedItemFingerprints = [...insurance.eligibility[0].deniedItemFingerprints];
    const report = verifyEnterpriseSharedBindingShadow({
      organizationId,
      bindings,
      consumers: [consumer("linggan-bank.wealth-manager", "wealth-manager", "a", "wealth"), insurance],
    });
    expect(report.status).toBe("FAIL");
    expect(report.eligibilityViolationCount).toBe(1);
  });
});
