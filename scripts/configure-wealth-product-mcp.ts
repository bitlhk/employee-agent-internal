import "dotenv/config";
import { recordAuditRequired } from "../server/_core/audit-events";
import { discoverCustomMcpTools } from "../server/_core/custom-mcp-client";
import { reconcileEnterpriseMcpRuntimeScopes } from "../server/_core/enterprise-mcp-runtime-reconcile";
import type { EnterpriseMcpToolPolicyDraft } from "../server/_core/enterprise-mcp-policy";
import {
  createEnterpriseMcpConnection,
  getEnterpriseMcpConnection,
  replaceAdminRoleAssetGrantsForAsset,
  updateEnterpriseMcpConnection,
  upsertEnterpriseMcpToolPolicies,
} from "../server/db";
import { closeDbConnection } from "../server/db/connection";

const SERVER_ID = "wealth_assistant_product";
const ROLE_KEY = "wealth-manager";
const ENDPOINT = String(
  process.env.EA_WEALTH_PRODUCT_MCP_CANONICAL_URL ||
    "https://mcp.demo.linggan.top/wealth/product-data/mcp"
).trim();
const EXPECTED_TOOLS = [
  "wealth_assistant_product_search",
  "wealth_assistant_product_info",
  "wealth_assistant_fund_info",
  "wealth_assistant_nav_history",
  "wealth_assistant_wealth_product",
  "wealth_assistant_market_news",
];

function readPolicy(toolName: string): EnterpriseMcpToolPolicyDraft {
  return {
    toolName,
    enabled: true,
    sideEffect: "read",
    requiredScopes: ["wealth.product.read"],
    allowedRoles: [ROLE_KEY],
    identityModeOverride: null,
    approvalMode: "never",
    auditLevel: "strong",
    idempotencyRequired: false,
    argumentPolicyJson: null,
  };
}

async function main() {
  const actor = "wealth-product-mcp-shadow-bootstrap";
  const existing = await getEnterpriseMcpConnection(SERVER_ID);
  const common = {
    displayName: "财富产品数据",
    description:
      "Demo/Shadow：查询财富理财与基金产品事实、企业演示在售资格和公开市场数据。正式推荐仍由 EA 适当性门禁决定。",
    icon: null,
    businessDomain: "wealth",
    endpointUrl: ENDPOINT,
    resourceUri: ENDPOINT,
    protocolVersion: "2025-11-25" as const,
    identityMode: "tenant" as const,
    authMode: "none_shadow" as const,
    dataClassification: "internal" as const,
    environment: "test" as const,
    lifecycleState: "shadow" as const,
    timeoutMs: 30_000,
    ownerDepartment: "财富管理开发团队",
    ownerContact: "待业务团队确认",
    healthUrl: null,
    identityVerificationStatus: "unknown" as const,
    identityVerificationError:
      "Demo/Shadow 服务尚未启用 EA 短期令牌验证，不得升级为企业生产 Enforced。",
    identityVerifiedAt: null,
    updatedBy: actor,
  };
  if (existing) await updateEnterpriseMcpConnection(SERVER_ID, common);
  else
    await createEnterpriseMcpConnection({
      serverId: SERVER_ID,
      ...common,
      createdBy: actor,
    });

  const tools = await discoverCustomMcpTools({
    endpointUrl: ENDPOINT,
    authType: "none",
    timeoutMs: 30_000,
  });
  const discovered = new Set(tools.map(tool => tool.name));
  const missingTools = EXPECTED_TOOLS.filter(tool => !discovered.has(tool));
  if (missingTools.length)
    throw new Error(
      `WEALTH_PRODUCT_MCP_TOOLS_MISSING:${missingTools.join(",")}`
    );

  await updateEnterpriseMcpConnection(SERVER_ID, {
    toolsJson: tools,
    healthStatus: "ready",
    lastError: null,
    lastTestedAt: new Date(),
    updatedBy: actor,
  });
  await upsertEnterpriseMcpToolPolicies({
    serverId: SERVER_ID,
    policies: EXPECTED_TOOLS.map(readPolicy),
    actor,
  });
  await replaceAdminRoleAssetGrantsForAsset({
    assetType: "mcp_server",
    assetId: SERVER_ID,
    grants: [{ roleKey: ROLE_KEY, grantMode: "default" }],
    actor,
  });
  const runtimeRefresh = await reconcileEnterpriseMcpRuntimeScopes({
    roleKeys: [ROLE_KEY],
    forceRefresh: true,
  });
  await recordAuditRequired({
    action: "mcp.connector.wealth_product_shadow.completed",
    result: "success",
    severity: "high",
    actorType: "system",
    actorName: actor,
    targetType: "enterprise_mcp_server",
    targetId: SERVER_ID,
    resourceType: "mcp_server",
    resourceId: SERVER_ID,
    source: "deployment_script",
    metadata: {
      endpointOrigin: new URL(ENDPOINT).origin,
      authMode: "none_shadow",
      lifecycleState: "shadow",
      toolNames: EXPECTED_TOOLS,
    },
  });
  console.log(
    JSON.stringify(
      {
        serverId: SERVER_ID,
        endpointUrl: ENDPOINT,
        toolNames: EXPECTED_TOOLS,
        lifecycleState: "shadow",
        productionReadiness: "blocked_until_identity_and_data_gates_pass",
        runtimeRefresh,
      },
      null,
      2
    )
  );
}

main()
  .then(async () => closeDbConnection())
  .catch(async error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
