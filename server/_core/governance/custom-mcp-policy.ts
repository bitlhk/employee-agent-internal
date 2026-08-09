import type { CustomMcpToolSnapshot } from "../../db/custom-mcp-connections";
import { POLICY_GATED_SIDE_EFFECTS, resolveToolGovernance, type ToolGovernanceProfile } from "../tool-governance";
import type { GovernanceDecisionDraft, GovernancePolicyAdapter } from "./contracts";
import { principalSupportsSideEffect, type PrincipalResolution } from "./principal";

const RULE_VERSION = "custom-mcp-v1";

export function resolveCustomMcpToolGovernance(tool: CustomMcpToolSnapshot): ToolGovernanceProfile {
  const inferred = resolveToolGovernance(tool.name);
  const annotations = tool.annotations || {};
  // Remote MCP annotations are untrusted hints. They may raise the platform's
  // inferred risk, but they must never downgrade it or masquerade as registry policy.
  if (annotations.destructiveHint === true && !POLICY_GATED_SIDE_EFFECTS.has(inferred.sideEffect)) {
    return {
      ...inferred,
      sideEffect: "write",
      policyRequired: true,
      approvalMode: "always",
      auditLevel: "strong",
      idempotencyRequired: true,
    };
  }
  if (POLICY_GATED_SIDE_EFFECTS.has(inferred.sideEffect) && !inferred.idempotencyRequired) {
    return { ...inferred, idempotencyRequired: true };
  }
  return inferred;
}

export function customMcpPolicyAdapter(input: {
  profile: ToolGovernanceProfile;
  principal: PrincipalResolution;
  runtimeAttested?: boolean;
}): GovernancePolicyAdapter {
  return {
    id: "custom-mcp-policy",
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
      if (POLICY_GATED_SIDE_EFFECTS.has(input.profile.sideEffect) && input.runtimeAttested === false) {
        return {
          effect: "DENY",
          policyCode: "EA_RUNTIME_GOVERNANCE_ATTESTATION_REQUIRED",
          ruleVersion: RULE_VERSION,
          reason: "Agent 运行时尚未证明治理挂钩有效，已阻止业务副作用。",
          obligations: [{ type: "AUDIT", level: "strong" }],
        };
      }
      if (!POLICY_GATED_SIDE_EFFECTS.has(input.profile.sideEffect)) {
        return {
          effect: "ALLOW",
          policyCode: "EA_CUSTOM_MCP_READ_ALLOWED",
          ruleVersion: RULE_VERSION,
          reason: "Custom MCP read or compute operation is allowed.",
          obligations: [{ type: "AUDIT", level: input.profile.auditLevel }],
        };
      }
      return {
        effect: "REQUIRE_APPROVAL",
        policyCode: "EA_CUSTOM_MCP_SIDE_EFFECT_APPROVAL_REQUIRED",
        ruleVersion: RULE_VERSION,
        reason: "该自定义 MCP 工具可能修改业务数据，需要用户按次确认。",
        obligations: [
          { type: "AUDIT", level: "strong" },
          { type: "APPROVAL", mode: input.profile.approvalMode === "always" ? "always" : "conditional" },
          ...(input.profile.idempotencyRequired ? [{ type: "IDEMPOTENCY_KEY" } as const] : []),
        ],
      };
    },
  };
}
