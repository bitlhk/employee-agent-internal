import "dotenv/config";
import { randomUUID } from "node:crypto";
import { recordAuditRequired } from "../server/_core/audit-events";
import { discoverCustomMcpTools } from "../server/_core/custom-mcp-client";
import { enterpriseMcpIdentityStatus, issueEnterpriseMcpAccessToken } from "../server/_core/enterprise-mcp-identity";
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
    description: "查询保险客户画像与客户基础信息；生产调用必须按租户和用户做行级过滤。",
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
    description: "查询保险产品、产品详情与培训考点；生产调用必须按租户隔离产品库。",
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
    authMode: "oauth2_access_token" as const,
    dataClassification: marker.dataClassification,
    environment: "prod" as const,
    lifecycleState: "shadow" as const,
    timeoutMs: 30_000,
    ownerDepartment: "保险业务团队",
    ownerContact: "待业务团队确认",
    healthUrl: null,
    identityVerificationStatus: "unknown" as const,
    identityVerificationError: null,
    identityVerifiedAt: null,
    updatedBy: actor,
  };
  if (existing) await updateEnterpriseMcpConnection(marker.serverId, common);
  else await createEnterpriseMcpConnection({ serverId: marker.serverId, ...common, createdBy: actor });

  const issued = await issueEnterpriseMcpAccessToken({
    caller: { userId: 0, organization: "linggan-platform", adoptId: "lgj-platform-bootstrap", agentId: "employee-agent-platform", roleKey: "platform-admin" },
    identityMode: "platform",
    resourceUri: marker.endpointUrl,
    serverId: marker.serverId,
    toolName: "tools/list",
    scopes: ["mcp.tools.read"],
    requestId: `emcp_bootstrap_${randomUUID()}`,
  });
  const tools = await discoverCustomMcpTools({
    endpointUrl: marker.endpointUrl,
    authType: "bearer",
    credential: issued.token,
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
      authMode: "oauth2_access_token",
      lifecycleState: "shadow",
      identityMode: marker.identityMode,
      toolNames: tools.map(tool => tool.name),
    },
  });
  return { serverId: marker.serverId, tools: tools.map(tool => tool.name) };
}

async function main() {
  const identity = await enterpriseMcpIdentityStatus();
  if (!identity.configured) throw new Error("Configure the enterprise MCP signing identity before bootstrapping marker services");
  const configured = [];
  for (const marker of markers) configured.push(await configureMarker(marker));
  const runtimeRefresh = await reconcileEnterpriseMcpRuntimeScopes({ roleKeys: [role], forceRefresh: true });
  console.log(JSON.stringify({
    issuer: identity.issuer,
    keyId: identity.keyId,
    markers: configured,
    lifecycleState: "shadow",
    identityVerification: "pending_service_remediation",
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
