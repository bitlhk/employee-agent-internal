import { describe, expect, it } from "vitest";
import type { ContextNeedPlanV1, ContextSourceBindingV1 } from "../../../shared/context-resolution";
import { applyContextResolutionOutcomes, resolveContextSources } from "./source-resolver";

const plan: ContextNeedPlanV1 = {
  schema: "ea.context-need-plan.v1",
  planId: "wealth.test",
  planVersion: "1",
  rolePackId: "linggan-bank.wealth-manager",
  roleTemplate: "wealth-manager",
  taskId: "WM-GT-02",
  needs: [
    {
      needId: "policy",
      logicalAssetId: "current_wealth_policy",
      contextType: "knowledge",
      requiredness: "required",
      purpose: "Current policy",
      freshness: { mode: "current_effective" },
    },
    {
      needId: "market",
      logicalAssetId: "current_market_view",
      contextType: "knowledge",
      requiredness: "optional",
      purpose: "Market view",
      freshness: { mode: "latest" },
    },
  ],
};

function binding(overrides: Partial<ContextSourceBindingV1> = {}): ContextSourceBindingV1 {
  return {
    schema: "ea.context-source-binding.v1",
    bindingId: "binding-policy",
    organizationId: "org-a",
    rolePackId: plan.rolePackId,
    bindingScope: "role_pack",
    logicalAssetId: "current_wealth_policy",
    contextType: "knowledge",
    providerType: "llamaindex",
    resourceRef: "kb://kb_policy_a",
    capabilities: ["metadata_filter", "citation"],
    bindingVersion: "1",
    stage: "production",
    status: "active",
    ...overrides,
  };
}

describe("deterministic context source resolver", () => {
  it("blocks when a required logical asset has no binding", () => {
    const resolved = resolveContextSources({ plan, bindings: [], organizationId: "org-a" });
    expect(resolved.status).toBe("BLOCKED");
    expect(resolved.resolutions[0].reasonCode).toBe("NO_BINDING");
  });

  it("degrades only when optional context is missing", () => {
    const resolved = resolveContextSources({ plan, bindings: [binding()], organizationId: "org-a" });
    expect(resolved.status).toBe("DEGRADED");
    expect(resolved.resolutions[0].binding?.resourceRef).toBe("kb://kb_policy_a");
  });

  it("prefers an organization binding over the wildcard without ambiguity", () => {
    const resolved = resolveContextSources({
      plan: { ...plan, needs: [plan.needs[0]] },
      bindings: [
        binding({ organizationId: "*", bindingId: "default", resourceRef: "kb://default" }),
        binding({ bindingId: "specific", resourceRef: "kb://specific" }),
      ],
      organizationId: "org-a",
    });
    expect(resolved.status).toBe("READY");
    expect(resolved.resolutions[0].binding?.bindingId).toBe("specific");
  });

  it("fails closed when the same logical asset has multiple active bindings", () => {
    const resolved = resolveContextSources({
      plan: { ...plan, needs: [plan.needs[0]] },
      bindings: [binding(), binding({ bindingId: "duplicate", resourceRef: "kb://other" })],
      organizationId: "org-a",
    });
    expect(resolved.status).toBe("BLOCKED");
    expect(resolved.resolutions[0].status).toBe("ambiguous");
    expect(resolved.resolutions[0].reasonCode).toBe("AMBIGUOUS_BINDING");
  });

  it("keeps shadow and production bindings isolated", () => {
    const resolved = resolveContextSources({
      plan: { ...plan, needs: [plan.needs[0]] },
      bindings: [binding(), binding({ bindingId: "shadow", stage: "shadow", resourceRef: "kb://candidate" })],
      organizationId: "org-a",
      stage: "shadow",
    });
    expect(resolved.resolutions[0].binding?.resourceRef).toBe("kb://candidate");
  });

  it("distinguishes disabled bindings from capability mismatches", () => {
    const disabled = resolveContextSources({
      plan: { ...plan, needs: [plan.needs[0]] },
      bindings: [binding({ status: "disabled" })],
      organizationId: "org-a",
    });
    expect(disabled.resolutions[0].reasonCode).toBe("EXACT_BINDING_DISABLED");

    const disabledOverride = resolveContextSources({
      plan: { ...plan, needs: [plan.needs[0]] },
      bindings: [
        binding({ organizationId: "*", bindingId: "default" }),
        binding({ status: "disabled" }),
      ],
      organizationId: "org-a",
    });
    expect(disabledOverride.resolutions[0].reasonCode).toBe("EXACT_BINDING_DISABLED");

    const mismatch = resolveContextSources({
      plan: { ...plan, needs: [{ ...plan.needs[0], requiredCapabilities: ["citation"] }] },
      bindings: [binding({ capabilities: ["metadata_filter"] })],
      organizationId: "org-a",
    });
    expect(mismatch.resolutions[0].reasonCode).toBe("EXACT_BINDING_CAPABILITY_MISMATCH");
  });

  it("falls back to one enterprise-shared binding for different Role Packs", () => {
    const shared = binding({
      bindingId: "shared-customer-profile",
      rolePackId: "*",
      bindingScope: "enterprise_shared",
      logicalAssetId: "customer_profile",
      contextType: "business_data",
      providerType: "mcp",
      resourceRef: "mcp://crm/customer_profile",
      capabilities: ["point_read"],
    });
    const need = {
      ...plan.needs[0],
      logicalAssetId: "customer_profile",
      contextType: "business_data" as const,
      requiredCapabilities: ["point_read"],
    };
    const wealth = resolveContextSources({
      plan: { ...plan, needs: [need] },
      bindings: [shared],
      organizationId: "org-a",
    });
    const insurance = resolveContextSources({
      plan: { ...plan, rolePackId: "linggan-insurance.insurance-advisor", needs: [need] },
      bindings: [shared],
      organizationId: "org-a",
    });
    expect(wealth.resolutions[0].binding?.bindingId).toBe("shared-customer-profile");
    expect(insurance.resolutions[0].binding?.bindingId).toBe("shared-customer-profile");
  });

  it("never falls back to shared when an exact override is disabled or incompatible", () => {
    const shared = binding({
      bindingId: "shared-policy",
      rolePackId: "*",
      bindingScope: "enterprise_shared",
      capabilities: ["citation"],
    });
    const disabled = resolveContextSources({
      plan: { ...plan, needs: [{ ...plan.needs[0], requiredCapabilities: ["citation"] }] },
      bindings: [shared, binding({ status: "disabled" })],
      organizationId: "org-a",
    });
    expect(disabled.resolutions[0].binding).toBeNull();
    expect(disabled.resolutions[0].reasonCode).toBe("EXACT_BINDING_DISABLED");

    const mismatch = resolveContextSources({
      plan: { ...plan, needs: [{ ...plan.needs[0], requiredCapabilities: ["citation"] }] },
      bindings: [shared, binding({ capabilities: ["metadata_filter"] })],
      organizationId: "org-a",
    });
    expect(mismatch.resolutions[0].binding).toBeNull();
    expect(mismatch.resolutions[0].reasonCode).toBe("EXACT_BINDING_CAPABILITY_MISMATCH");
  });

  it("fails closed on ambiguous shared bindings and distinguishes a missing shared mapping", () => {
    const shared = binding({
      bindingId: "shared-policy-a",
      rolePackId: "*",
      bindingScope: "enterprise_shared",
    });
    const ambiguous = resolveContextSources({
      plan: { ...plan, needs: [plan.needs[0]] },
      bindings: [shared, { ...shared, bindingId: "shared-policy-b", resourceRef: "kb://other" }],
      organizationId: "org-a",
    });
    expect(ambiguous.resolutions[0].reasonCode).toBe("AMBIGUOUS_SHARED_BINDING");

    const missing = resolveContextSources({
      plan: { ...plan, needs: [plan.needs[1]] },
      bindings: [shared],
      organizationId: "org-a",
    });
    expect(missing.resolutions[0].reasonCode).toBe("NO_SHARED_BINDING");
  });

  it("rejects organization-wildcard shared bindings", () => {
    const resolved = resolveContextSources({
      plan: { ...plan, needs: [plan.needs[0]] },
      bindings: [binding({
        organizationId: "*",
        rolePackId: "*",
        bindingScope: "enterprise_shared",
      })],
      organizationId: "org-a",
    });
    expect(resolved.resolutions[0].reasonCode).toBe("NO_BINDING");
  });

  it("fails readiness when a healthy binding returns no usable Context", () => {
    const resolved = resolveContextSources({
      plan,
      bindings: [
        binding(),
        binding({ bindingId: "market", logicalAssetId: "current_market_view", resourceRef: "kb://kb_market_a" }),
      ],
      organizationId: "org-a",
    });
    const required = applyContextResolutionOutcomes({
      plan: resolved,
      outcomes: [{ logicalAssetId: "current_wealth_policy", usable: false, reasonCode: "NO_USABLE_CONTEXT" }],
    });
    expect(required?.status).toBe("BLOCKED");
    expect(required?.resolutions[0].reasonCode).toBe("NO_USABLE_CONTEXT");

    const optional = applyContextResolutionOutcomes({
      plan: resolved,
      outcomes: [{ logicalAssetId: "current_market_view", usable: false, reasonCode: "SOURCE_UNAVAILABLE" }],
    });
    expect(optional?.status).toBe("DEGRADED");
  });
});
