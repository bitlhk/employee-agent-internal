import type { TaskExecutionEnvelope } from "./governance/task-execution-envelope";
import {
  buildContextReceiptFromEnvelope,
  type ContextReceiptAppliedPolicy,
} from "./governance/context-receipt";
import type { WealthAllocationContextResult } from "./wealth-allocation-context";
import type { WealthPolicyBasis } from "./wealth-policy-source";

export function buildWealthPolicyContextReceipt(input: {
  envelope: Readonly<TaskExecutionEnvelope>;
  basis: WealthPolicyBasis;
  policyReady: boolean;
}) {
  return buildContextReceiptFromEnvelope({
    envelope: input.envelope,
    knowledgeLabels: input.basis.selected ? [{
      assetId: input.basis.selected.sourceAssetId,
      label: `${input.basis.selected.documentName.replace(/\.md$/i, "")} ${input.basis.selected.versionLabel}`.trim(),
    }] : [],
    policyDecisions: [{
      policyCode: "EA_KNOWLEDGE_ELIGIBILITY_V1",
      ruleVersion: "knowledge-eligibility-v1",
      effect: input.policyReady ? "ALLOW" : "DENY",
    }],
    capabilityExecutions: [{
      capabilityId: "get_wealth_policy_basis",
      label: "核验现行政策",
      operation: "resolve_current_policy",
      status: input.policyReady ? "completed" : "blocked",
    }],
    excluded: input.basis.governance.filteredForValidity > 0 ? [{
      category: "knowledge",
      reasonCode: "HISTORICAL_VERSION_FILTERED",
      count: input.basis.governance.filteredForValidity,
      message: `已过滤 ${input.basis.governance.filteredForValidity} 份失效或尚未生效的同系列资料。`,
      disclosure: "exact_count",
    }] : [],
  });
}

export function buildWealthAllocationContextReceipt(input: {
  envelope: Readonly<TaskExecutionEnvelope>;
  result: WealthAllocationContextResult;
}) {
  const policyDecisions: ContextReceiptAppliedPolicy[] = input.result.evidence.decisions.map((decision) => ({
    decisionId: decision.policyDecisionId,
    policyCode: decision.policyCode,
    ruleVersion: input.result.evidence.ruleVersion,
    effect: decision.effect,
  }));
  return buildContextReceiptFromEnvelope({
    envelope: input.envelope,
    knowledgeLabels: input.result.policySource.sourceAssetId ? [{
      assetId: input.result.policySource.sourceAssetId,
      label: `财富产品适当性销售依据 ${input.result.policySource.versionLabel}`.trim(),
    }] : [],
    businessDataLabels: [
      { sourceSystem: "wealth_customer_mcp", label: "当前客户画像与风险测评" },
      { sourceSystem: "wealth_product_mcp", label: "当前可售产品池" },
    ],
    policyDecisions,
    capabilityExecutions: [{
      capabilityId: "prepare_wealth_allocation_context",
      label: "筛选资产配置候选",
      operation: "evaluate_allocation_candidates",
      status: input.result.status === "ready" ? "completed" : "blocked",
    }],
    excluded: input.result.excludedProducts.length ? [{
      category: "product",
      reasonCode: "SUITABILITY_POLICY_FILTERED",
      count: input.result.excludedProducts.length,
      message: `已排除 ${input.result.excludedProducts.length} 个不满足当前适当性规则的产品候选。`,
      disclosure: "exact_count",
    }] : [],
  });
}
