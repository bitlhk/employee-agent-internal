import type { RuntimePrincipalV2 } from "../governance/contracts";
import { governanceFingerprint, principalFingerprint } from "../governance/contracts";
import { buildTaskContextPack } from "../governance/task-execution-envelope";
import type { WealthAllocationContextResult } from "../wealth-allocation-context";
import {
  contextBindingEvidence,
  contextResolutionEvidence,
  applyContextResolutionEvidenceOutcomes,
  observeWealthContextResolutionShadow,
  resolveWealthKnowledgeSource,
  resolveWealthTaskContextSnapshot,
  resolvedContextBinding,
  wealthKnowledgeSourceFromPlan,
  type WealthKnowledgeSourceResolution,
} from "./wealth-source-resolution";
import { mcpResourceRef, resolveMcpBindingTarget, type McpBindingTarget } from "./mcp-adapter";

export type WealthAllocationRuntimeSources = {
  enabled: boolean;
  knowledgeSource?: WealthKnowledgeSourceResolution;
  profileTarget: McpBindingTarget;
  portfolioTarget: McpBindingTarget;
  productTarget: McpBindingTarget;
  resolutionEvidence: ReturnType<typeof contextResolutionEvidence>;
  profileBindingEvidence: ReturnType<typeof contextBindingEvidence>;
  portfolioBindingEvidence: ReturnType<typeof contextBindingEvidence>;
  productBindingEvidence: ReturnType<typeof contextBindingEvidence>;
};

const GOVERNED_CUSTOMER_TOOLS = new Set([
  "get_governed_customer_profile",
  "get_customer_profile",
  "get_customer_portfolio",
]);

function observedMcpResourceRef(target: McpBindingTarget, legacyService: string): string {
  return mcpResourceRef(
    GOVERNED_CUSTOMER_TOOLS.has(target.toolName) ? "customer-profile" : legacyService,
    target.toolName,
  );
}

export function finalizeWealthPolicyResolutionEvidence(input: {
  evidence: ReturnType<typeof contextResolutionEvidence>;
  ready: boolean;
  reasonCode?: WealthAllocationContextResult["policySource"]["resolutionReasonCode"];
}) {
  return applyContextResolutionEvidenceOutcomes({
    evidence: input.evidence,
    outcomes: [{
      logicalAssetId: "current_wealth_policy",
      usable: input.ready,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    }],
  });
}

export async function resolveWealthPolicyRuntimeSource(principal: RuntimePrincipalV2) {
  const knowledgeSource = await resolveWealthKnowledgeSource({
    taskId: "WM-GT-03",
    logicalAssetId: "current_wealth_policy",
    principal,
  });
  return {
    knowledgeSource,
    resolutionEvidence: contextResolutionEvidence([knowledgeSource.plan]),
  };
}

export async function observeWealthPolicyRuntimeSource(input: {
  principal: RuntimePrincipalV2;
  knowledgeBaseId?: string;
  resourceRef?: string;
}): Promise<void> {
  await observeWealthContextResolutionShadow({
    taskId: "WM-GT-03",
    principal: input.principal,
    observed: input.resourceRef || input.knowledgeBaseId ? [{
      logicalAssetId: "current_wealth_policy",
      providerType: "llamaindex",
      resourceRef: input.resourceRef || `kb://${input.knowledgeBaseId}`,
    }] : [],
  });
}

export async function resolveWealthAllocationRuntimeSources(input: {
  taskId: "WM-GT-02" | "WM-GT-04";
  principal: RuntimePrincipalV2;
  customerEndpoint: string;
  productEndpoint: string;
}): Promise<WealthAllocationRuntimeSources> {
  const legacy = {
    enabled: false,
    profileTarget: { endpointUrl: input.customerEndpoint, toolName: "wealth_assistant_customer_detail" },
    portfolioTarget: { endpointUrl: input.customerEndpoint, toolName: "wealth_assistant_customer_detail" },
    productTarget: { endpointUrl: input.productEndpoint, toolName: "wealth_assistant_product_search" },
    resolutionEvidence: undefined,
    profileBindingEvidence: null,
    portfolioBindingEvidence: null,
    productBindingEvidence: null,
  };
  if (input.taskId !== "WM-GT-02") return legacy;
  const contextSnapshot = await resolveWealthTaskContextSnapshot({
    taskId: input.taskId,
    organizationId: input.principal.organizationId,
    contextTypes: ["knowledge", "business_data"],
  });
  const knowledgeSource = wealthKnowledgeSourceFromPlan(
    contextSnapshot.plans.knowledge,
    "current_wealth_policy",
  );
  const businessResolution = contextSnapshot.plans.business_data || { mode: "legacy" as const, plan: null };
  let profileTarget = legacy.profileTarget;
  let portfolioTarget = legacy.portfolioTarget;
  let productTarget = legacy.productTarget;
  if (businessResolution.mode === "binding") {
    const profileBinding = resolvedContextBinding(businessResolution.plan, "customer_profile");
    const portfolioBinding = resolvedContextBinding(businessResolution.plan, "customer_portfolio");
    const productsBinding = resolvedContextBinding(businessResolution.plan, "available_products");
    if (!profileBinding || !portfolioBinding || !productsBinding) {
      throw new Error("必需业务上下文来源未完成绑定");
    }
    profileTarget = resolveMcpBindingTarget(profileBinding);
    portfolioTarget = resolveMcpBindingTarget(portfolioBinding);
    productTarget = resolveMcpBindingTarget(productsBinding);
  }
  return {
    enabled: true,
    knowledgeSource,
    profileTarget,
    portfolioTarget,
    productTarget,
    resolutionEvidence: contextResolutionEvidence([knowledgeSource.plan, businessResolution.plan]),
    profileBindingEvidence: contextBindingEvidence(resolvedContextBinding(businessResolution.plan, "customer_profile")),
    portfolioBindingEvidence: contextBindingEvidence(resolvedContextBinding(businessResolution.plan, "customer_portfolio")),
    productBindingEvidence: contextBindingEvidence(resolvedContextBinding(businessResolution.plan, "available_products")),
  };
}

export async function observeWealthAllocationRuntimeSources(
  sources: WealthAllocationRuntimeSources,
  principal: RuntimePrincipalV2,
  legacyKnowledgeBaseId?: string,
): Promise<void> {
  if (!sources.enabled) return;
  const knowledgeResourceRef = sources.knowledgeSource?.binding?.resourceRef
    || (legacyKnowledgeBaseId ? `kb://${legacyKnowledgeBaseId}` : "");
  await observeWealthContextResolutionShadow({
    taskId: "WM-GT-02",
    principal,
    observed: [
      { logicalAssetId: "customer_profile", providerType: "mcp", resourceRef: observedMcpResourceRef(sources.profileTarget, "wealth-customer") },
      { logicalAssetId: "customer_portfolio", providerType: "mcp", resourceRef: observedMcpResourceRef(sources.portfolioTarget, "wealth-customer") },
      { logicalAssetId: "available_products", providerType: "mcp", resourceRef: mcpResourceRef("wealth-product", sources.productTarget.toolName) },
      ...(knowledgeResourceRef ? [{
        logicalAssetId: "current_wealth_policy",
        providerType: "llamaindex" as const,
        resourceRef: knowledgeResourceRef,
      }] : []),
    ],
  });
}

export function buildWealthAllocationTaskContextPack(input: {
  sources: WealthAllocationRuntimeSources;
  result: WealthAllocationContextResult;
  principal: RuntimePrincipalV2;
}) {
  return buildTaskContextPack({
    ...(input.sources.resolutionEvidence ? {
      resolution: finalizeWealthPolicyResolutionEvidence({
        evidence: input.sources.resolutionEvidence,
        ready: input.result.policySource.ready,
        reasonCode: input.result.policySource.resolutionReasonCode,
      }),
    } : {}),
    knowledge: {
      selectedAssets: input.result.policySource.sourceAssetId ? [{
        assetId: input.result.policySource.sourceAssetId,
        version: input.result.policySource.versionLabel,
        contentHash: "",
        effectiveAt: input.result.policySource.effectiveAt,
        ...(input.result.policySource.sourceBinding || {}),
      }] : [],
      eligibilityFingerprint: input.result.policySource.eligibilityFingerprint,
    },
    businessData: {
      sources: [
        {
          sourceSystem: "enterprise_customer_profile_provider",
          entityRef: input.result.customer.customerId,
          asOf: input.result.evidence.profileDataAsOf,
          resultFingerprint: input.result.evidence.profileResultFingerprint,
          ...(input.sources.profileBindingEvidence || {}),
        },
        {
          sourceSystem: "wealth_customer_portfolio",
          entityRef: input.result.customer.customerId,
          asOf: input.result.evidence.portfolioDataAsOf,
          resultFingerprint: input.result.evidence.portfolioResultFingerprint,
          ...(input.sources.portfolioBindingEvidence || {}),
        },
        {
          sourceSystem: "wealth_product_mcp",
          entityRef: "eligible-product-set",
          asOf: input.result.evidence.productDataAsOf[0] || "",
          resultFingerprint: governanceFingerprint({
            eligible: input.result.eligibleProducts,
            excluded: input.result.excludedProducts,
          }),
          ...(input.sources.productBindingEvidence || {}),
        },
      ],
    },
    memory: { memoryRefs: [] },
    principalFingerprint: principalFingerprint(input.principal),
    assembledAt: new Date().toISOString(),
  });
}
