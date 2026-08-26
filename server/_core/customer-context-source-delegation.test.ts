import { beforeEach, describe, expect, it } from "vitest";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import {
  issueCustomerSourceDelegation,
  resetCustomerSourceDelegationsForTests,
  resolveCustomerSourceDelegation,
} from "./customer-context-source-delegation";

const principal: RuntimePrincipalV2 = {
  userId: 2,
  adoptionId: "lgj-lihongkun",
  agentId: "jiuwen_lgj-lihongkun",
  roleTemplate: "wealth-manager",
  workspaceId: "/tmp/wealth",
  permissionProfile: "internal",
  sessionId: "session",
  taskId: "WM-GT-01",
  tenantId: "tenant",
  organizationId: "organization",
  authorizationSnapshotId: "snapshot",
  authorizationFingerprint: "fingerprint",
  identityVersion: "2",
};

describe("Customer Context source delegation", () => {
  beforeEach(() => resetCustomerSourceDelegationsForTests());

  it("issues an unguessable source identity bound to one upstream server", () => {
    const delegation = issueCustomerSourceDelegation({
      principal,
      sourceServerId: "wealth_assistant_customer",
    });
    expect(delegation.sourceAgentId).toMatch(/^ea_cc_[a-f0-9]{32}$/u);
    expect(resolveCustomerSourceDelegation(
      delegation.sourceAgentId,
      "wealth_assistant_customer",
    )).toMatchObject({
      adoptionId: principal.adoptionId,
      runtimeAgentId: principal.agentId,
      roleTemplate: principal.roleTemplate,
    });
    expect(resolveCustomerSourceDelegation(
      delegation.sourceAgentId,
      "insurance_customer_profile",
    )).toBeNull();
  });

  it("rejects source delegation across role boundaries", () => {
    expect(() => issueCustomerSourceDelegation({
      principal,
      sourceServerId: "insurance_customer_profile",
    })).toThrow("CUSTOMER_CONTEXT_SOURCE_ROLE_NOT_AUTHORIZED");
  });
});
