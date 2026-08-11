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

type MarkerDefinition = {
  serverId: string;
  displayName: string;
  description: string;
  endpointUrl: string;
  identityMode: "tenant" | "user";
  dataClassification: "internal" | "sensitive";
  policies: EnterpriseMcpToolPolicyDraft[];
};

const role = "insurance-advisor";
const readPolicy = (toolName: string, scope: string): EnterpriseMcpToolPolicyDraft => ({
  toolName,
  enabled: true,
  sideEffect: "read",
  requiredScopes: [scope],
  allowedRoles: [role],
  identityModeOverride: null,
  approvalMode: "never",
  auditLevel: "strong",
  idempotencyRequired: false,
  argumentPolicyJson: null,
});

const markers: MarkerDefinition[] = [
  {
    serverId: "insurance_customer_profile",
    displayName: "保险客户画像",
    description: "Demo/Shadow：查询 Mock 保险客户画像与客户基础信息；生产调用必须完成可信身份验证和用户行级过滤。",
    endpointUrl: "https://mcp.demo.linggan.top/insurance/customer-profile/mcp",
    identityMode: "user",
    dataClassification: "sensitive",
    policies: [
      readPolicy("list_customer_profiles", "insurance.customer.read"),
      readPolicy("get_customer_profile_by_name", "insurance.customer.read"),
    ],
  },
  {
    serverId: "insurance_product_exam_points",
    displayName: "保险产品考点",
    description: "Demo/Shadow：查询 Mock 保险产品、产品详情与培训考点；生产调用必须完成可信身份验证和租户隔离。",
    endpointUrl: "https://mcp.demo.linggan.top/insurance/product-exam-points/mcp",
    identityMode: "tenant",
    dataClassification: "internal",
    policies: [
      readPolicy("list_products", "insurance.product.read"),
      readPolicy("search_products", "insurance.product.read"),
      readPolicy("get_product_detail", "insurance.product.read"),
      readPolicy("get_exam_points", "insurance.product.read"),
      {
        toolName: "save_product",
        enabled: false,
        sideEffect: "write",
        requiredScopes: ["insurance.product.write"],
        allowedRoles: [role],
        identityModeOverride: "user",
        approvalMode: "always",
        auditLevel: "highest",
        idempotencyRequired: true,
        argumentPolicyJson: null,
      },
    ],
  },
];

async function configureMarker(marker: MarkerDefinition) {
  const actor = "enterprise-mcp-marker-bootstrap";
  const existing = await getEnterpriseMcpConnection(marker.serverId);
  const common = {
    displayName: marker.displayName,
    description: marker.description,
    icon: null,
    businessDomain: "insurance",
    endpointUrl: marker.endpointUrl,
    resourceUri: marker.endpointUrl,
    protocolVersion: "2025-11-25" as const,
    identityMode: marker.identityMode,
    authMode: "none_shadow" as const,
    dataClassification: marker.dataClassification,
    environment: "test" as const,
    lifecycleState: "shadow" as const,
    timeoutMs: 30_000,
    ownerDepartment: "保险业务团队",
    ownerContact: "待业务团队确认",
    healthUrl: null,
    identityVerificationStatus: "unknown" as const,
    identityVerificationError: "Demo/Shadow 服务未启用可信身份验证，不得升级为企业生产 Enforced。",
    identityVerifiedAt: null,
    updatedBy: actor,
  };
  if (existing) await updateEnterpriseMcpConnection(marker.serverId, common);
  else await createEnterpriseMcpConnection({ serverId: marker.serverId, ...common, createdBy: actor });

  const tools = await discoverCustomMcpTools({
    endpointUrl: marker.endpointUrl,
    authType: "none",
    timeoutMs: 30_000,
  });
  await updateEnterpriseMcpConnection(marker.serverId, {
    toolsJson: tools,
    healthStatus: "ready",
    lastError: null,
    lastTestedAt: new Date(),
    updatedBy: actor,
  });
  await upsertEnterpriseMcpToolPolicies({ serverId: marker.serverId, policies: marker.policies, actor });
  await replaceAdminRoleAssetGrantsForAsset({
    assetType: "mcp_server",
    assetId: marker.serverId,
    grants: [{ roleKey: role, grantMode: "default" }],
    actor,
  });
  await recordAuditRequired({
    action: "mcp.connector.marker_bootstrap.completed",
    result: "success",
    severity: "high",
    actorType: "system",
    actorName: actor,
    targetType: "enterprise_mcp_server",
    targetId: marker.serverId,
    resourceType: "mcp_server",
    resourceId: marker.serverId,
    source: "deployment_script",
    metadata: {
      endpointOrigin: new URL(marker.endpointUrl).origin,
      authMode: "none_shadow",
      environment: "test",
      lifecycleState: "shadow",
      identityMode: marker.identityMode,
      toolNames: tools.map(tool => tool.name),
    },
  });
  return { serverId: marker.serverId, tools: tools.map(tool => tool.name) };
}

async function main() {
  const configured = [];
  for (const marker of markers) configured.push(await configureMarker(marker));
  const runtimeRefresh = await reconcileEnterpriseMcpRuntimeScopes({ roleKeys: [role], forceRefresh: true });
  console.log(JSON.stringify({
    markers: configured,
    environment: "test",
    authMode: "none_shadow",
    lifecycleState: "shadow",
    readiness: "demo_shadow_ready",
    productionReadiness: "blocked_until_jwks_and_row_level_filtering",
    runtimeRefresh,
  }, null, 2));
}

main()
  .then(async () => closeDbConnection())
  .catch(async error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    await closeDbConnection().catch(() => undefined);
  });
