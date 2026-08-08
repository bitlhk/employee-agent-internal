import { POLICY_GATED_SIDE_EFFECTS, type ToolGovernanceProfile } from "../tool-governance";
import type { GovernanceDecisionDraft, GovernancePolicyAdapter } from "./contracts";
import { principalSupportsSideEffect, type PrincipalResolution } from "./principal";

const RULE_VERSION = "platform-mcp-v1";

export function platformMcpPolicyAdapter(input: {
  knownTool: boolean;
  profile: ToolGovernanceProfile;
  principal: PrincipalResolution;
  runtimeAttested?: boolean;
}): GovernancePolicyAdapter {
  return {
    id: "platform-mcp-policy",
    evaluate(): GovernanceDecisionDraft {
      if (!input.knownTool) {
        return {
          effect: "DENY",
          policyCode: "EA_PLATFORM_MCP_TOOL_UNKNOWN",
          ruleVersion: RULE_VERSION,
          reason: "Platform MCP tool is not registered.",
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
      if (!principalSupportsSideEffect(input.principal, input.profile.sideEffect)) {
        return {
          effect: "DENY",
          policyCode: "EA_PRINCIPAL_INCOMPLETE",
          ruleVersion: RULE_VERSION,
          reason: `Runtime principal is incomplete: ${input.principal.issues.join(", ")}`,
          obligations: [{ type: "AUDIT", level: "strong" }],
        };
      }
      return {
        effect: "ALLOW",
        policyCode: "EA_PLATFORM_MCP_POLICY_V1",
        ruleVersion: RULE_VERSION,
        reason: "Registered platform capability is allowed for the active adoption.",
        obligations: [
          { type: "AUDIT", level: input.profile.auditLevel },
          ...(input.profile.idempotencyRequired ? [{ type: "IDEMPOTENCY_KEY" } as const] : []),
        ],
      };
    },
  };
}
