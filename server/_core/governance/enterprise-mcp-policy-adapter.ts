import type { EnterpriseMcpToolPolicyDraft } from "../enterprise-mcp-policy";
import { POLICY_GATED_SIDE_EFFECTS } from "../tool-governance";
import type { GovernanceDecisionDraft, GovernancePolicyAdapter } from "./contracts";
import { principalSupportsSideEffect, type PrincipalResolution } from "./principal";

const RULE_VERSION = "enterprise-mcp-v2";

export function enterpriseMcpPolicyAdapter(input: {
  policy: EnterpriseMcpToolPolicyDraft;
  principal: PrincipalResolution;
  runtimeAttested?: boolean;
}): GovernancePolicyAdapter {
  return {
    id: "enterprise-mcp-policy",
    evaluate(request): GovernanceDecisionDraft {
      if (!principalSupportsSideEffect(input.principal, request.operation.sideEffect)) {
        return {
          effect: "DENY",
          policyCode: "EA_PRINCIPAL_INCOMPLETE",
          ruleVersion: RULE_VERSION,
          reason: `运行身份不完整，缺少：${input.principal.issues.join(", ")}`,
          obligations: [{ type: "AUDIT", level: "strong" }],
        };
      }
      if (POLICY_GATED_SIDE_EFFECTS.has(input.policy.sideEffect) && input.runtimeAttested === false) {
        return {
          effect: "DENY",
          policyCode: "EA_RUNTIME_GOVERNANCE_ATTESTATION_REQUIRED",
          ruleVersion: RULE_VERSION,
          reason: "Agent 运行时尚未证明治理挂钩有效，已阻止企业业务副作用。",
          obligations: [{ type: "AUDIT", level: "strong" }],
        };
      }
      const obligations: GovernanceDecisionDraft["obligations"] = [
        { type: "AUDIT", level: input.policy.auditLevel },
        { type: "EGRESS_GUARD" },
      ];
      if (input.policy.idempotencyRequired) obligations.push({ type: "IDEMPOTENCY_KEY" });
      if (input.policy.approvalMode !== "never") {
        obligations.push({
          type: "APPROVAL",
          mode: input.policy.approvalMode === "always" ? "always" : "conditional",
        });
        return {
          effect: "REQUIRE_APPROVAL",
          policyCode: "EA_ENTERPRISE_MCP_APPROVAL_REQUIRED",
          ruleVersion: RULE_VERSION,
          reason: "该企业工具按组织策略需要当前用户人工确认。",
          obligations,
        };
      }
      return {
        effect: "ALLOW",
        policyCode: "EA_ENTERPRISE_MCP_ALLOWED",
        ruleVersion: RULE_VERSION,
        reason: "Enterprise MCP policy allows this operation.",
        obligations,
      };
    },
  };
}
