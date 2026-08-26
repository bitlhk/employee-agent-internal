import { beforeEach, describe, expect, it } from "vitest";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import {
  issueCustomerSourceDelegation,
  resetCustomerSourceDelegationsForTests,
} from "./customer-context-source-delegation";
import { resolveMcpAgentAuthorization } from "./mcp-agent-authorization";

const claw = {
  adoptId: "lgj-lihongkun",
  agentId: "jiuwen_lgj-lihongkun",
  roleTemplate: "wealth-manager",
  status: "active",
};
const principal = {
  userId: 2,
  adoptionId: claw.adoptId,
  agentId: claw.agentId,
  roleTemplate: claw.roleTemplate,
  workspaceId: "/tmp/wealth",
  permissionProfile: "internal",
  sessionId: "session",
  taskId: "WM-GT-01",
  tenantId: "tenant",
  organizationId: "organization",
  authorizationSnapshotId: "snapshot",
  authorizationFingerprint: "fingerprint",
  identityVersion: "2",
} satisfies RuntimePrincipalV2;

const assets = {
  skills: { default: [], optional: [] },
  mcpServers: { default: ["customer_context"], optional: [] },
};

describe("MCP Agent authorization", () => {
  beforeEach(() => resetCustomerSourceDelegationsForTests());

  it("keeps the raw customer source denied to the runtime Agent", async () => {
    const result = await resolveMcpAgentAuthorization(
      { agentId: claw.agentId, mcpServerId: "wealth_assistant_customer" },
      {
        getByAgentId: async () => claw as never,
        resolveAssets: async () => assets as never,
      },
    );
    expect(result).toMatchObject({
      status: 403,
      body: { authorized: false, reason: "role_or_asset_not_authorized" },
    });
  });

  it("authorizes only a short-lived customer-context source identity", async () => {
    const delegation = issueCustomerSourceDelegation({
      principal,
      sourceServerId: "wealth_assistant_customer",
    });
    const result = await resolveMcpAgentAuthorization(
      {
        agentId: delegation.sourceAgentId,
        mcpServerId: "wealth_assistant_customer",
      },
      {
        getByAdoptId: async () => claw as never,
        resolveAssets: async () => assets as never,
      },
    );
    expect(result).toMatchObject({
      status: 200,
      body: {
        authorized: true,
        reason: "customer_context_source_delegation",
        agentId: claw.agentId,
        adoptId: claw.adoptId,
      },
    });
  });
});
