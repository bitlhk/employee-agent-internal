import { parseCustomMcpEndpoint } from "./custom-mcp-client";
import { resolveToolGovernance, type ToolSideEffect } from "./tool-governance";

export const ENTERPRISE_MCP_SERVER_ID_RE = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;
export const ENTERPRISE_MCP_SCOPE_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export type EnterpriseMcpLifecycleState = "legacy" | "shadow" | "enforced" | "disabled";
export type EnterpriseMcpAuthMode = "oauth2_access_token" | "static_bearer_legacy" | "none_shadow";

export type EnterpriseMcpConfigForValidation = {
  serverId: string;
  endpointUrl: string;
  resourceUri: string;
  healthUrl?: string | null;
  authMode: EnterpriseMcpAuthMode;
  lifecycleState: EnterpriseMcpLifecycleState;
  identityMode: "platform" | "tenant" | "user";
  dataClassification: "public" | "internal" | "sensitive" | "restricted";
  timeoutMs: number;
};

function parseHttpsUrl(value: string, label: string): URL {
  try {
    return parseCustomMcpEndpoint(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateEnterpriseMcpConfig(input: EnterpriseMcpConfigForValidation): void {
  if (!ENTERPRISE_MCP_SERVER_ID_RE.test(input.serverId)) {
    throw new Error("serverId 只能包含小写字母、数字、点、下划线和连字符");
  }
  const endpoint = parseHttpsUrl(input.endpointUrl, "MCP 地址无效");
  const resource = parseHttpsUrl(input.resourceUri, "Resource URI 无效");
  if (endpoint.origin !== resource.origin) {
    throw new Error("Resource URI 必须与 MCP 地址使用相同站点");
  }
  if (input.healthUrl) parseHttpsUrl(input.healthUrl, "健康检查地址无效");
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 120_000) {
    throw new Error("超时时间必须在 1000 到 120000 毫秒之间");
  }
  if (input.lifecycleState === "enforced" && input.authMode === "none_shadow") {
    throw new Error("未鉴权连接器只能处于影子或停用状态，不能进入强制运行态");
  }
  if (input.dataClassification === "restricted" && input.identityMode !== "user") {
    throw new Error("严格受限数据必须使用用户身份模式");
  }
}

export type EnterpriseMcpToolPolicyDraft = {
  toolName: string;
  enabled: boolean;
  sideEffect: ToolSideEffect;
  requiredScopes: string[];
  allowedRoles: string[] | null;
  identityModeOverride: "platform" | "tenant" | "user" | null;
  approvalMode: "never" | "conditional" | "always";
  auditLevel: "normal" | "strong" | "highest";
  idempotencyRequired: boolean;
  argumentPolicyJson: Record<string, unknown> | null;
};

export function enterpriseMcpRoleAllowed(policy: EnterpriseMcpToolPolicyDraft, roleKey: string): boolean {
  if (!policy.allowedRoles || policy.allowedRoles.length === 0) return true;
  return policy.allowedRoles.includes("*") || policy.allowedRoles.includes(roleKey);
}

export function validateEnterpriseMcpToolArguments(
  policy: EnterpriseMcpToolPolicyDraft,
  args: Record<string, unknown>,
): void {
  const configured = policy.argumentPolicyJson;
  const maxBytesRaw = Number(configured?.maxBytes || 512 * 1024);
  const maxBytes = Number.isFinite(maxBytesRaw)
    ? Math.min(512 * 1024, Math.max(1024, Math.floor(maxBytesRaw)))
    : 512 * 1024;
  if (Buffer.byteLength(JSON.stringify(args)) > maxBytes) throw new Error(`工具参数超过 ${maxBytes} 字节`);

  const requiredFields = Array.isArray(configured?.requiredFields)
    ? configured.requiredFields.map(String).filter(Boolean)
    : [];
  for (const field of requiredFields) {
    if (!(field in args) || args[field] === undefined || args[field] === null || args[field] === "") {
      throw new Error(`工具参数缺少必填字段: ${field}`);
    }
  }

  const blockedFields = new Set(Array.isArray(configured?.blockedFields)
    ? configured.blockedFields.map(String).filter(Boolean)
    : []);
  const blocked = Object.keys(args).filter(key => blockedFields.has(key));
  if (blocked.length > 0) throw new Error(`工具参数包含禁用字段: ${blocked.join(", ")}`);

  const allowedFields = Array.isArray(configured?.allowedFields)
    ? new Set(configured.allowedFields.map(String).filter(Boolean))
    : null;
  if (allowedFields) {
    const unexpected = Object.keys(args).filter(key => !allowedFields.has(key));
    if (unexpected.length > 0) throw new Error(`工具参数包含未授权字段: ${unexpected.join(", ")}`);
  }
}

export function validateEnterpriseMcpToolPolicy(input: EnterpriseMcpToolPolicyDraft): void {
  if (!input.toolName.trim() || input.toolName.length > 256) throw new Error("工具名称无效");
  if (input.requiredScopes.length > 32 || input.requiredScopes.some(scope => !ENTERPRISE_MCP_SCOPE_RE.test(scope))) {
    throw new Error(`工具 ${input.toolName} 的 scope 无效`);
  }
  if (input.allowedRoles && input.allowedRoles.length > 100) throw new Error("岗位范围过大");
  if (["write", "financial_action", "approval_action", "admin_action"].includes(input.sideEffect) && !input.idempotencyRequired) {
    throw new Error(`工具 ${input.toolName} 具有写入副作用，必须启用幂等保护`);
  }
  if (input.sideEffect === "financial_action" && input.approvalMode === "never") {
    throw new Error(`工具 ${input.toolName} 涉及金融动作，必须配置人工确认`);
  }
}

export function inferEnterpriseMcpToolPolicy(toolName: string): EnterpriseMcpToolPolicyDraft {
  const profile = resolveToolGovernance(toolName);
  return {
    toolName,
    enabled: profile.sideEffect === "read" || profile.sideEffect === "compute",
    sideEffect: profile.sideEffect,
    requiredScopes: [],
    allowedRoles: null,
    identityModeOverride: null,
    approvalMode: profile.approvalMode,
    auditLevel: profile.auditLevel,
    idempotencyRequired: profile.idempotencyRequired,
    argumentPolicyJson: null,
  };
}
