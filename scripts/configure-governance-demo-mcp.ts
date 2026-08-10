import "dotenv/config";
import {
  createEnterpriseMcpConnection,
  getEnterpriseMcpConnection,
  replaceAdminRoleAssetGrantsForAsset,
  updateEnterpriseMcpConnection,
  upsertEnterpriseMcpToolPolicies,
} from "../server/db";
import {
  GOVERNANCE_DEMO_MCP_PATH,
  GOVERNANCE_DEMO_MCP_SERVER_ID,
  governanceDemoMcpTools,
} from "../server/_core/governance-demo-mcp";
import { enterpriseMcpIdentityStatus } from "../server/_core/enterprise-mcp-identity";
import { resolvePublicBaseUrl } from "../server/_core/public-base-url";
import { reconcileEnterpriseMcpRuntimeScopes } from "../server/_core/enterprise-mcp-runtime-reconcile";
import { closeDbConnection } from "../server/db/connection";

async function main() {
  const baseUrl = String(process.env.EA_GOVERNANCE_DEMO_BASE_URL || resolvePublicBaseUrl()).replace(/\/$/, "");
  const endpointUrl = `${baseUrl}${GOVERNANCE_DEMO_MCP_PATH}`;
  if (!endpointUrl.startsWith("https://")) throw new Error("Demo MCP public endpoint must use HTTPS");
  const identity = await enterpriseMcpIdentityStatus();
  if (!identity.configured) throw new Error("Enterprise MCP identity signing must be configured first");

  const existing = await getEnterpriseMcpConnection(GOVERNANCE_DEMO_MCP_SERVER_ID);
  const common = {
    displayName: "财富业务演示 MCP（Demo）",
    description: "Governed Runtime 演示连接：创建方案草稿、更新演示客户标签；所有写入仅进入隔离 Demo 表。",
    icon: null,
    businessDomain: "wealth-demo",
    endpointUrl,
    resourceUri: endpointUrl,
    protocolVersion: "2025-11-25" as const,
    identityMode: "user" as const,
    authMode: "oauth2_access_token" as const,
    dataClassification: "internal" as const,
    environment: "test" as const,
    lifecycleState: "enforced" as const,
    timeoutMs: 15_000,
    ownerDepartment: "Employee Agent Demo",
    ownerContact: "平台管理员",
    healthUrl: `${endpointUrl}/health`,
    updatedBy: "governance-demo-bootstrap",
  };
  if (existing) {
    await updateEnterpriseMcpConnection(GOVERNANCE_DEMO_MCP_SERVER_ID, common);
  } else {
    await createEnterpriseMcpConnection({
      serverId: GOVERNANCE_DEMO_MCP_SERVER_ID,
      ...common,
      createdBy: "governance-demo-bootstrap",
    });
  }

  const tools = governanceDemoMcpTools().map(tool => ({ ...tool }));
  await updateEnterpriseMcpConnection(GOVERNANCE_DEMO_MCP_SERVER_ID, {
    toolsJson: tools,
    healthStatus: "ready",
    lastError: null,
    lastTestedAt: new Date(),
    updatedBy: "governance-demo-bootstrap",
  });
  await upsertEnterpriseMcpToolPolicies({
    serverId: GOVERNANCE_DEMO_MCP_SERVER_ID,
    actor: "governance-demo-bootstrap",
    policies: [
      {
        toolName: "demo_get_business_record",
        enabled: true,
        sideEffect: "read",
        requiredScopes: ["demo.portfolio.read"],
        allowedRoles: ["wealth-manager"],
        identityModeOverride: "user",
        approvalMode: "never",
        auditLevel: "strong",
        idempotencyRequired: false,
        argumentPolicyJson: null,
      },
      {
        toolName: "demo_create_portfolio_draft",
        enabled: true,
        sideEffect: "write",
        requiredScopes: ["demo.portfolio.write"],
        allowedRoles: ["wealth-manager"],
        identityModeOverride: "user",
        approvalMode: "always",
        auditLevel: "highest",
        idempotencyRequired: true,
        argumentPolicyJson: null,
      },
      {
        toolName: "demo_update_customer_profile",
        enabled: true,
        sideEffect: "write",
        requiredScopes: ["demo.customer.write"],
        allowedRoles: ["wealth-manager"],
        identityModeOverride: "user",
        approvalMode: "always",
        auditLevel: "highest",
        idempotencyRequired: true,
        argumentPolicyJson: null,
      },
    ],
  });
  await replaceAdminRoleAssetGrantsForAsset({
    assetType: "mcp_server",
    assetId: GOVERNANCE_DEMO_MCP_SERVER_ID,
    grants: [{ roleKey: "wealth-manager", grantMode: "default" }],
    actor: "governance-demo-bootstrap",
  });
  const refresh = await reconcileEnterpriseMcpRuntimeScopes({
    serverId: GOVERNANCE_DEMO_MCP_SERVER_ID,
    roleKeys: ["wealth-manager"],
    forceRefresh: true,
  });
  console.log(JSON.stringify({
    configured: true,
    displayName: "财富业务演示 MCP（Demo）",
    endpointUrl,
    tools: tools.map(tool => tool.name),
    runtimeRefresh: refresh,
  }, null, 2));
}

main()
  .then(async () => closeDbConnection())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
