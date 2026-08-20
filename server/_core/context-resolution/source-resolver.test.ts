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
    expect(disabled.resolutions[0].reasonCode).toBe("BINDING_DISABLED");

    const disabledOverride = resolveContextSources({
      plan: { ...plan, needs: [plan.needs[0]] },
      bindings: [
        binding({ organizationId: "*", bindingId: "default" }),
        binding({ status: "disabled" }),
      ],
      organizationId: "org-a",
    });
    expect(disabledOverride.resolutions[0].reasonCode).toBe("BINDING_DISABLED");

    const mismatch = resolveContextSources({
      plan: { ...plan, needs: [{ ...plan.needs[0], requiredCapabilities: ["citation"] }] },
      bindings: [binding({ capabilities: ["metadata_filter"] })],
      organizationId: "org-a",
    });
    expect(mismatch.resolutions[0].reasonCode).toBe("CAPABILITY_MISMATCH");
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
