import { randomUUID } from "node:crypto";
import type { RuntimePrincipalV2 } from "./governance/contracts";

const DELEGATION_TTL_MS = 45_000;
const MAX_DELEGATIONS = 10_000;

type CustomerSourceServerId =
  | "wealth_assistant_customer"
  | "insurance_customer_profile";

type CustomerSourceDelegationV1 = {
  sourceAgentId: string;
  sourceServerId: CustomerSourceServerId;
  adoptionId: string;
  runtimeAgentId: string;
  roleTemplate: string;
  expiresAt: number;
};

const allowedRoles: Record<CustomerSourceServerId, ReadonlySet<string>> = {
  wealth_assistant_customer: new Set(["wealth-manager"]),
  insurance_customer_profile: new Set(["insurance-advisor"]),
};

const delegations = new Map<string, CustomerSourceDelegationV1>();

function prune(now = Date.now()): void {
  for (const [key, delegation] of delegations) {
    if (delegation.expiresAt <= now) delegations.delete(key);
  }
  while (delegations.size >= MAX_DELEGATIONS) {
    const oldest = delegations.keys().next().value;
    if (!oldest) break;
    delegations.delete(oldest);
  }
}

export function issueCustomerSourceDelegation(input: {
  principal: RuntimePrincipalV2;
  sourceServerId: CustomerSourceServerId;
}): CustomerSourceDelegationV1 {
  if (!allowedRoles[input.sourceServerId].has(input.principal.roleTemplate)) {
    throw new Error("CUSTOMER_CONTEXT_SOURCE_ROLE_NOT_AUTHORIZED");
  }
  prune();
  const sourceAgentId = `ea_cc_${randomUUID().replaceAll("-", "")}`;
  const delegation: CustomerSourceDelegationV1 = {
    sourceAgentId,
    sourceServerId: input.sourceServerId,
    adoptionId: input.principal.adoptionId,
    runtimeAgentId: input.principal.agentId,
    roleTemplate: input.principal.roleTemplate,
    expiresAt: Date.now() + DELEGATION_TTL_MS,
  };
  delegations.set(sourceAgentId, delegation);
  return delegation;
}

export function resolveCustomerSourceDelegation(
  sourceAgentId: string,
  sourceServerId: string,
): CustomerSourceDelegationV1 | null {
  prune();
  const delegation = delegations.get(String(sourceAgentId || "").trim());
  if (!delegation || delegation.sourceServerId !== sourceServerId) return null;
  return delegation;
}

export function resetCustomerSourceDelegationsForTests(): void {
  delegations.clear();
}
