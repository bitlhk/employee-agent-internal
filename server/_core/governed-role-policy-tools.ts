import type { Request } from "express";
import type { RuntimePrincipal } from "./governance/contracts";
import { handleInvestmentResearchTool, INVESTMENT_RESEARCH_TOOLS } from "./investment-research-tool-handler";
import { handleSmartAuditTool, SMART_AUDIT_TOOLS } from "./smart-audit-tool-handler";

export const GOVERNED_ROLE_POLICY_TOOLS = [
  ...SMART_AUDIT_TOOLS,
  ...INVESTMENT_RESEARCH_TOOLS,
] as const;

export async function handleGovernedRolePolicyTool(input: {
  req: Request;
  name: string;
  args: Record<string, unknown>;
  adoptId: string;
  principal: RuntimePrincipal;
}) {
  if (SMART_AUDIT_TOOLS.some((tool) => tool.name === input.name)) return handleSmartAuditTool(input);
  return handleInvestmentResearchTool(input);
}
