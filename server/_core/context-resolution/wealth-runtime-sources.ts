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
  customerTarget: McpBindingTarget;
  productTarget: McpBindingTarget;
  resolutionEvidence: ReturnType<typeof contextResolutionEvidence>;
  customerBindingEvidence: ReturnType<typeof contextBindingEvidence>;
  productBindingEvidence: ReturnType<typeof contextBindingEvidence>;
};

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
    customerTarget: { endpointUrl: input.customerEndpoint, toolName: "wealth_assistant_customer_detail" },
    productTarget: { endpointUrl: input.productEndpoint, toolName: "wealth_assistant_product_search" },
    resolutionEvidence: undefined,
    customerBindingEvidence: null,
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
  let customerTarget = legacy.customerTarget;
  let productTarget = legacy.productTarget;
  if (businessResolution.mode === "binding") {
    const profileBinding = resolvedContextBinding(businessResolution.plan, "customer_profile");
    const portfolioBinding = resolvedContextBinding(businessResolution.plan, "customer_portfolio");
    const productsBinding = resolvedContextBinding(businessResolution.plan, "available_products");
    if (!profileBinding || !portfolioBinding || !productsBinding) {
      throw new Error("必需业务上下文来源未完成绑定");
    }
    customerTarget = resolveMcpBindingTarget(profileBinding);
    const portfolioTarget = resolveMcpBindingTarget(portfolioBinding);
    if (customerTarget.endpointUrl !== portfolioTarget.endpointUrl || customerTarget.toolName !== portfolioTarget.toolName) {
      throw new Error("当前配置处理器不能合并不同的客户画像与持仓来源");
    }
    productTarget = resolveMcpBindingTarget(productsBinding);
  }
  return {
    enabled: true,
    knowledgeSource,
    customerTarget,
    productTarget,
    resolutionEvidence: contextResolutionEvidence([knowledgeSource.plan, businessResolution.plan]),
    customerBindingEvidence: contextBindingEvidence(resolvedContextBinding(businessResolution.plan, "customer_profile")),
    productBindingEvidence: contextBindingEvidence(resolvedContextBinding(businessResolution.plan, "available_products")),
  };
}

export async function observeWealthAllocationRuntimeSources(
  sources: WealthAllocationRuntimeSources,
  principal: RuntimePrincipalV2,
): Promise<void> {
  if (!sources.enabled) return;
  await observeWealthContextResolutionShadow({
    taskId: "WM-GT-02",
    principal,
    observed: [
      { logicalAssetId: "customer_profile", providerType: "mcp", resourceRef: mcpResourceRef("wealth-customer", sources.customerTarget.toolName) },
      { logicalAssetId: "customer_portfolio", providerType: "mcp", resourceRef: mcpResourceRef("wealth-customer", sources.customerTarget.toolName) },
      { logicalAssetId: "available_products", providerType: "mcp", resourceRef: mcpResourceRef("wealth-product", sources.productTarget.toolName) },
      ...(sources.knowledgeSource?.binding ? [{
        logicalAssetId: "current_wealth_policy",
        providerType: "llamaindex" as const,
        resourceRef: sources.knowledgeSource.binding.resourceRef,
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
        ...(input.result.policySource.sourceBinding || {}),
      }] : [],
      eligibilityFingerprint: input.result.policySource.eligibilityFingerprint,
    },
    businessData: {
      sources: [
        {
          sourceSystem: "wealth_customer_mcp",
          entityRef: input.result.customer.customerId,
          asOf: input.result.evidence.customerDataAsOf,
          resultFingerprint: governanceFingerprint(input.result.customer),
          ...(input.sources.customerBindingEvidence || {}),
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
