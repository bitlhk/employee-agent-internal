import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ContextSourceBindingV1 } from "../../shared/context-resolution";
import {
  CUSTOMER_CONTEXT_ADMIN_NAME,
  CUSTOMER_CONTEXT_CANONICAL_TOOLS,
  CUSTOMER_CONTEXT_CONTRACT,
  CUSTOMER_CONTEXT_DESCRIPTION,
  CUSTOMER_CONTEXT_SERVICE_NAME,
  customerContextToolNames,
} from "../../shared/customer-context-contract";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import {
  governanceFingerprint,
  principalFingerprint,
} from "./governance/contracts";
import {
  attachContextReceipt,
  buildContextReceipt,
  persistTrustedContextReceiptResult,
} from "./governance/context-receipt";
import { resolveRuntimePrincipalV2 } from "./governance/principal";
import { isAuthorizedInternalRequest } from "./helpers";
import { authorizeAndBindInternalRuntimeRequest } from "./internal-runtime-request";
import { internalMcpAudience } from "./internal-runtime-token";
import {
  loadInsuranceCustomerProfileCompatibilitySource,
  loadWealthCustomerProfileCompatibilitySource,
  type CustomerProfileCompatibilityLoadResultV1,
} from "./customer-profile-compatibility-adapter";
import { loadTwentyCustomerProfileCompatibilitySource } from "./customer-profile-twenty-adapter";
import {
  createConfiguredTwentyCustomerProfileLoader,
  twentyCustomerContextEnabled,
  twentyCustomerContextProductionReady,
} from "./customer-context-twenty-access";
import { executeEnterpriseMcpGatewayTool } from "./enterprise-mcp-gateway";
import { getClawByAdoptId, getUserById } from "../db";
import {
  projectCustomerProfile,
  type CustomerProfileProviderInputV1,
} from "./customer-profile-provider";
import { recordAuditBestEffort, auditRequest } from "./audit-events";
import { listContextSourceBindingContracts } from "../db/context-source-bindings";
import { resolveContextSources } from "./context-resolution/source-resolver";
import { sharedBindingCandidateFingerprint } from "./context-resolution/shared-binding-validation-snapshot";
import {
  customerDirectoryRequest,
  defaultCustomerDirectoryLoader,
  defaultCustomerPortfolioLoader,
  type CustomerContextSourceEvidenceV1,
  type CustomerDirectoryLoaderV1,
  type CustomerDirectoryResultV1,
  type CustomerPortfolioLoaderV1,
  type CustomerPortfolioResultV1,
} from "./customer-context-tools";

const SERVICE_NAME = CUSTOMER_CONTEXT_SERVICE_NAME;
const SERVICE_VERSION = "2.0.0";
const PROFILE_TOOL_NAME = "get_customer_profile";
const LEGACY_PROFILE_TOOL_NAME = "get_governed_customer_profile";
type JsonObject = Record<string, unknown>;
export type CustomerProfileSourceLoaderV1 = (input: {
  principal: RuntimePrincipalV2;
  subjectId: string;
  customerName?: string;
  request?: Request;
}) => Promise<CustomerProfileCompatibilityLoadResultV1>;
export type CustomerProfileBindingResolverV1 = (input: {
  principal: RuntimePrincipalV2;
  stage: "shadow" | "production";
}) => Promise<ContextSourceBindingV1>;
export type CustomerProfileProviderToolResultV1 = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type RegisterCustomerProfileMcpOptionsV1 = {
  sourceLoader?: CustomerProfileSourceLoaderV1;
  bindingResolver?: CustomerProfileBindingResolverV1;
  directoryLoader?: CustomerDirectoryLoaderV1;
  portfolioLoader?: CustomerPortfolioLoaderV1;
};
const PROFILE_TOOL = {
  name: PROFILE_TOOL_NAME,
  description: [
    "Return the governed customer_profile projection for the current signed Runtime Principal.",
    "The role and purpose are derived from trusted runtime identity and cannot be selected by tool arguments.",
    "A blocked result contains no customer field values.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description:
          "Stable enterprise customer subject id already selected in the current authorized workflow.",
      },
      customer_name: {
        type: "string",
        description:
          "Optional source locator for legacy providers; never accepted as identity proof.",
      },
      task_id: {
        type: "string",
        description:
          "Optional Golden Task or governed task id used to apply task-required fields.",
      },
    },
    required: ["customer_id"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
  },
};
const DIRECTORY_TOOL = {
  name: "search_customers",
  description: [
    "Search customers within the current signed Runtime Principal's authorized directory.",
    "Dedicated customers are returned before shared demo customers.",
    "Use scope=assigned when the user asks for customers they personally own or when selecting a preferred CRM write target.",
    "The role, organization and service scope are derived from trusted runtime identity.",
    "Use the returned stable customer_id in subsequent customer tools.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional customer id or display-name query.",
      },
      scope: {
        type: "string",
        enum: ["all", "assigned", "demo_public"],
        default: "all",
        description:
          "all returns dedicated and shared demo customers; assigned returns only dedicated customers; demo_public returns the shared demo pool.",
      },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      offset: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const PORTFOLIO_TOOL = {
  name: "get_customer_portfolio",
  description: [
    "Return the governed wealth portfolio projection for an authorized customer.",
    "Raw customer biography, contact details and upstream recommendations are excluded.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      customer_id: {
        type: "string",
        description: "Stable customer id returned by search_customers.",
      },
      task_id: { type: "string", description: "Optional governed task id." },
    },
    required: ["customer_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const LEGACY_TOOLS = {
  [LEGACY_PROFILE_TOOL_NAME]: {
    ...PROFILE_TOOL,
    name: LEGACY_PROFILE_TOOL_NAME,
    description:
      "Compatibility alias for get_customer_profile. New Skills must use get_customer_profile.",
  },
  wealth_assistant_context_probe: {
    name: "wealth_assistant_context_probe",
    description:
      "Compatibility readiness probe. New Skills should use the canonical customer tools directly.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  wealth_assistant_customer_list: {
    name: "wealth_assistant_customer_list",
    description:
      "Compatibility alias for search_customers. New Skills must use search_customers.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        query: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  wealth_assistant_customer_detail: {
    name: "wealth_assistant_customer_detail",
    description:
      "Compatibility projection combining governed profile and portfolio. New Skills must use get_customer_profile and get_customer_portfolio.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        customer_id: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  list_customer_profiles: {
    name: "list_customer_profiles",
    description:
      "Compatibility alias for search_customers. New Skills must use search_customers.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  get_customer_profile_by_name: {
    name: "get_customer_profile_by_name",
    description:
      "Compatibility lookup that resolves a stable customer id before get_customer_profile. New Skills must use stable ids.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
} as const;
const TOOL_BY_NAME = new Map<string, Record<string, unknown>>([
  [DIRECTORY_TOOL.name, DIRECTORY_TOOL],
  [PROFILE_TOOL.name, PROFILE_TOOL],
  [PORTFOLIO_TOOL.name, PORTFOLIO_TOOL],
  ...Object.entries(LEGACY_TOOLS),
]);

type CustomerProfileProviderModeV1 = "disabled" | "shadow" | "production";

function enabled(name: string): boolean {
  return (
    String(process.env[name] || "")
      .trim()
      .toLowerCase() === "true"
  );
}

export function customerProfileProviderMode(): CustomerProfileProviderModeV1 {
  const explicit = String(process.env.EA_CUSTOMER_PROFILE_PROVIDER_MODE || "")
    .trim()
    .toLowerCase();
  if (
    explicit === "disabled" ||
    explicit === "shadow" ||
    explicit === "production"
  )
    return explicit;
  return enabled("EA_CUSTOMER_PROFILE_PROVIDER_SHADOW_ENABLED")
    ? "shadow"
    : "disabled";
}

function bindingRequired(): boolean {
  return Boolean(
    String(process.env.EA_CUSTOMER_PROFILE_PROVIDER_MODE || "").trim()
  );
}

function demoFactsEnabled(): boolean {
  if (!enabled("EA_CUSTOMER_PROFILE_DEMO_FACTS_ENABLED")) return false;
  const mode = customerProfileProviderMode();
  return (
    mode === "shadow" ||
    (mode === "production" &&
      enabled("EA_CUSTOMER_PROFILE_DEMO_RUNTIME_ENABLED"))
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function trustedAdoptId(req: Request): string {
  return firstString(
    req.headers["x-agent-adopt-id"],
    req.headers["x-workforce-agent-adopt-id"],
    req.headers["x-jiuwen-channel-id"]
  );
}

function trustedSessionId(req: Request): string {
  return firstString(
    req.headers["x-linggan-session-id"],
    req.headers["x-jiuwen-session-id"]
  );
}

function customerEntityRef(subjectId: string): string {
  return `customer:${createHash("sha256")
    .update(subjectId)
    .digest("hex")
    .slice(0, 24)}`;
}

function sourceAsOf(sources: Array<{ asOf: string }>): string {
  return (
    sources
      .map(source => source.asOf)
      .filter(Boolean)
      .sort()
      .at(-1) || ""
  );
}

function customerProfileBusinessLabel(purposeId: string): string {
  if (purposeId === "wealth_advisory") return "财富服务客户画像";
  if (purposeId === "insurance_advisory") return "保险服务客户画像";
  return "岗位所需客户画像";
}

function customerContextBusinessLabel(
  logicalContextId: "customer_directory" | "customer_portfolio"
): string {
  return logicalContextId === "customer_directory"
    ? "授权客户范围"
    : "客户持仓";
}

function remediationFor(reasonCodes: string[]): string[] {
  const remediation: string[] = [];
  if (reasonCodes.includes("CUSTOMER_PROFILE_PROVIDER_NOT_PRODUCTION_READY"))
    remediation.push(
      "完成数据源授权、权威数据时间和岗位用途字段裁剪后再启用。"
    );
  if (reasonCodes.includes("CUSTOMER_PROFILE_PROVIDER_NOT_DEMO_READY"))
    remediation.push("请提供已获准用于隔离演示环境的数据源。");
  if (reasonCodes.includes("CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING"))
    remediation.push("请补齐当前任务必需的客户字段及字段来源。");
  if (reasonCodes.includes("SUBJECT_OUT_OF_SCOPE"))
    remediation.push("请选择当前岗位和业务用途授权范围内的客户。");
  if (reasonCodes.includes("PRINCIPAL_NOT_AUTHORIZED"))
    remediation.push("请先完成当前岗位的客户数据源授权审核。");
  if (!remediation.length) remediation.push("请处理客户画像治理问题后重试。");
  return remediation;
}

function providerReceipt(input: {
  principal: RuntimePrincipalV2;
  projection: ReturnType<typeof projectCustomerProfile>;
  binding?: ContextSourceBindingV1;
  toolName?: string;
}) {
  const { projection, principal, binding } = input;
  const toolName = input.toolName || PROFILE_TOOL_NAME;
  const provided =
    projection.status === "BLOCKED"
      ? []
      : [
          {
            sourceSystem: "enterprise_customer_profile_provider",
            label: customerProfileBusinessLabel(projection.purposeId),
            entityRef: customerEntityRef(projection.subjectId),
            asOf: sourceAsOf(projection.sourceEvidence),
            resultFingerprint: governanceFingerprint(projection),
            logicalAssetId: "customer_profile",
            providerType: "mcp" as const,
            ...(binding
              ? {
                  bindingId: binding.bindingId,
                  resourceRefFingerprint: governanceFingerprint(
                    binding.resourceRef
                  ),
                  candidateBindingFingerprint:
                    binding.stage === "shadow"
                      ? sharedBindingCandidateFingerprint(binding)
                      : undefined,
                }
              : {}),
          },
        ];
  const allowed = projection.status !== "BLOCKED";
  return buildContextReceipt({
    taskId: projection.taskId || "CUSTOMER-PROFILE-SHADOW",
    taskLabel: "客户信息核验",
    principalFingerprint: principalFingerprint(principal),
    provided: {
      knowledge: [],
      businessData: provided,
      memory: [],
      capabilities: [
        {
          capabilityId: toolName,
          label: "客户画像读取",
          version: SERVICE_VERSION,
          sideEffect: "read",
        },
      ],
    },
    policyDecisions: [
      {
        policyCode: "EA_CUSTOMER_PROFILE_PURPOSE_PROJECTION_V1",
        ruleVersion: projection.projectionVersion,
        effect: allowed ? "ALLOW" : "DENY",
      },
    ],
    capabilityExecutions: [
      {
        capabilityId: toolName,
        operation: "project_customer_profile",
        status: allowed ? "completed" : "blocked",
      },
    ],
    excluded: allowed
      ? []
      : [
          {
            category: "business_data",
            reasonCode: projection.reasonCodes[0] || "CUSTOMER_PROFILE_BLOCKED",
            count: Math.max(1, projection.sourceEvidence.length),
            message: "客户画像未通过岗位用途与授权校验，本轮未提供相关字段。",
            disclosure: "aggregate_only",
          },
        ],
    readiness: {
      status: projection.status,
      requestedOutcome: "governed_customer_profile",
      allowedOutcomes: allowed ? ["governed_customer_profile"] : [],
      deniedOutcomes: allowed ? [] : ["governed_customer_profile"],
      reasons: projection.reasonCodes,
      remediation: allowed ? [] : remediationFor(projection.reasonCodes),
      decisionFingerprint: governanceFingerprint({
        projectionId: projection.projectionId,
        projectionVersion: projection.projectionVersion,
        status: projection.status,
        reasonCodes: projection.reasonCodes,
        principalFingerprint: projection.principalFingerprint,
      }),
    },
    now: new Date(projection.generatedAt),
  });
}

function textResult(
  projection: ReturnType<typeof projectCustomerProfile>,
  principal: RuntimePrincipalV2,
  loaded: CustomerProfileCompatibilityLoadResultV1,
  binding?: ContextSourceBindingV1,
  toolName?: string
): CustomerProfileProviderToolResultV1 {
  const receipt = providerReceipt({ projection, principal, binding, toolName });
  return attachContextReceipt(
    {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(projection),
        },
      ],
      ...(projection.status === "BLOCKED" ? { isError: true } : {}),
      _meta: {
        eaCustomerProfileAdapter: {
          schemaVersion: "ea.customer-profile-adapter-evidence.v1",
          sourceCount: loaded.sources.length,
          sourceContractIds: loaded.sources.map(
            source => source.sourceContractId
          ),
          sourceSystems: loaded.sources.map(source => source.sourceSystem),
          assuranceLevels: loaded.sources.map(
            source =>
              source.assuranceLevel ||
              (source.productionReady ? "production" : "candidate")
          ),
          principalAuthorized: loaded.principalAuthorized,
          subjectInScope: loaded.subjectInScope,
          notes: loaded.notes.map(note => note.slice(0, 500)),
          containsCustomerValues: false,
        },
      },
    },
    receipt
  );
}

export const defaultCustomerProfileSourceLoader: CustomerProfileSourceLoaderV1 =
  async input => {
    if (twentyCustomerContextEnabled())
      return loadTwentyCustomerProfileCompatibilitySource({
        principal: input.principal,
        subjectId: input.subjectId,
        recordLoader: createConfiguredTwentyCustomerProfileLoader(),
        productionReady: twentyCustomerContextProductionReady(),
      });
    if (input.principal.roleTemplate === "wealth-manager")
      return loadWealthCustomerProfileCompatibilitySource({
        ...input,
        includeDemoFacts: demoFactsEnabled(),
      });
    if (input.principal.roleTemplate === "insurance-advisor") {
      if (!input.request)
        return {
          sources: [],
          principalAuthorized: false,
          subjectInScope: false,
          notes: [
            "insurance compatibility adapter requires the authenticated EA request context",
          ],
        };
      return loadInsuranceCustomerProfileCompatibilitySource({
        principal: input.principal,
        subjectId: input.subjectId,
        includeDemoFacts: demoFactsEnabled(),
        callEnterpriseTool: async call =>
          executeEnterpriseMcpGatewayTool({
            req: input.request as Request,
            adoptId: input.principal.adoptionId,
            sessionId: input.principal.sessionId,
            serverId: call.serverId,
            toolName: call.toolName,
            arguments: call.args,
            taskAuthorizationSnapshotId:
              input.principal.authorizationSnapshotId,
            executionOrigin: "customer_profile_adapter",
          }),
      });
    }
    return {
      sources: [],
      principalAuthorized: true,
      subjectInScope: false,
      notes: ["role has no active Customer Profile source adapter"],
    };
  };

export async function executeCustomerProfileProviderTool(input: {
  principal: RuntimePrincipalV2;
  args: JsonObject;
  sourceLoader?: CustomerProfileSourceLoaderV1;
  request?: Request;
  binding?: ContextSourceBindingV1;
  toolName?: string;
}): Promise<CustomerProfileProviderToolResultV1> {
  const subjectId = firstString(
    input.args.customer_id,
    input.args.customerId
  ).slice(0, 128);
  if (!subjectId) throw new Error("customer_id is required");
  const customerName = firstString(
    input.args.customer_name,
    input.args.customerName
  ).slice(0, 200);
  const taskId = firstString(input.args.task_id, input.args.taskId).slice(
    0,
    128
  );
  const loaded = await (
    input.sourceLoader || defaultCustomerProfileSourceLoader
  )({
    principal: input.principal,
    subjectId,
    ...(customerName ? { customerName } : {}),
    ...(input.request ? { request: input.request } : {}),
  });
  const projectionInput: CustomerProfileProviderInputV1 = {
    roleTemplate: input.principal.roleTemplate,
    ...(taskId ? { taskId } : {}),
    requestedSubjectId: loaded.resolvedSubjectId || subjectId,
    principalFingerprint: principalFingerprint(input.principal),
    principalAuthorized: loaded.principalAuthorized,
    subjectInScope: loaded.subjectInScope,
    sources: loaded.sources,
    requiredAssuranceLevel: demoFactsEnabled() ? "demo" : "production",
  };
  return textResult(
    projectCustomerProfile(projectionInput),
    input.principal,
    loaded,
    input.binding,
    input.toolName
  );
}

function parseToolPayload(
  result: CustomerProfileProviderToolResultV1
): JsonObject {
  try {
    return object(JSON.parse(result.content[0]?.text || "{}"));
  } catch {
    return {};
  }
}

function governedBusinessDataReceipt(input: {
  principal: RuntimePrincipalV2;
  logicalContextId: "customer_directory" | "customer_portfolio";
  toolName: string;
  status: "READY" | "DEGRADED" | "BLOCKED";
  sourceEvidence: CustomerContextSourceEvidenceV1[];
  result: unknown;
  taskId?: string;
}) {
  const allowed = input.status !== "BLOCKED";
  return buildContextReceipt({
    taskId: input.taskId || `CUSTOMER-CONTEXT-${input.logicalContextId}`,
    taskLabel: "客户信息核验",
    principalFingerprint: principalFingerprint(input.principal),
    provided: {
      knowledge: [],
      businessData: allowed
        ? [
            {
              sourceSystem: "enterprise_customer_context",
              label: customerContextBusinessLabel(input.logicalContextId),
              entityRef: input.logicalContextId,
              asOf: sourceAsOf(input.sourceEvidence),
              resultFingerprint: governanceFingerprint(input.result),
              logicalAssetId: input.logicalContextId,
              providerType: "mcp",
            },
          ]
        : [],
      memory: [],
      capabilities: [
        {
          capabilityId: input.toolName,
          label: input.toolName,
          version: SERVICE_VERSION,
          sideEffect: "read",
        },
      ],
    },
    policyDecisions: [
      {
        policyCode: "EA_CUSTOMER_CONTEXT_PRINCIPAL_SCOPE_V1",
        ruleVersion: CUSTOMER_CONTEXT_CONTRACT,
        effect: allowed ? "ALLOW" : "DENY",
      },
    ],
    capabilityExecutions: [
      {
        capabilityId: input.toolName,
        operation: input.toolName,
        status: allowed ? "completed" : "blocked",
      },
    ],
    readiness: {
      status: input.status,
      requestedOutcome: input.logicalContextId,
      allowedOutcomes: allowed ? [input.logicalContextId] : [],
      deniedOutcomes: allowed ? [] : [input.logicalContextId],
      reasons: allowed ? [] : ["CUSTOMER_CONTEXT_BLOCKED"],
      remediation: allowed ? [] : ["请确认当前岗位、业务用途和客户授权范围。"],
      decisionFingerprint: governanceFingerprint({
        logicalContextId: input.logicalContextId,
        status: input.status,
        principal: principalFingerprint(input.principal),
      }),
    },
  });
}

function attachBusinessResult(input: {
  principal: RuntimePrincipalV2;
  logicalContextId: "customer_directory" | "customer_portfolio";
  toolName: string;
  result: CustomerDirectoryResultV1 | CustomerPortfolioResultV1 | JsonObject;
  status: "READY" | "DEGRADED" | "BLOCKED";
  sourceEvidence: CustomerContextSourceEvidenceV1[];
  taskId?: string;
}): CustomerProfileProviderToolResultV1 {
  return attachContextReceipt(
    {
      content: [{ type: "text" as const, text: JSON.stringify(input.result) }],
      ...(input.status === "BLOCKED" ? { isError: true } : {}),
      _meta: {
        eaCustomerContext: {
          schemaVersion: CUSTOMER_CONTEXT_CONTRACT,
          toolName: input.toolName,
          logicalContextId: input.logicalContextId,
          sourceSystems: input.sourceEvidence.map(
            source => source.sourceSystem
          ),
          containsRawUpstreamPayload: false,
        },
      },
    },
    governedBusinessDataReceipt(input)
  );
}

async function executeDirectoryTool(input: {
  principal: RuntimePrincipalV2;
  args: JsonObject;
  request?: Request;
  loader?: CustomerDirectoryLoaderV1;
  toolName: string;
}): Promise<CustomerProfileProviderToolResultV1> {
  const request = customerDirectoryRequest(input.args);
  const result = await (input.loader || defaultCustomerDirectoryLoader)({
    principal: input.principal,
    request: input.request,
    ...request,
  });
  return attachBusinessResult({
    principal: input.principal,
    logicalContextId: "customer_directory",
    toolName: input.toolName,
    result,
    status: result.status,
    sourceEvidence: result.sourceEvidence,
  });
}

async function executePortfolioTool(input: {
  principal: RuntimePrincipalV2;
  args: JsonObject;
  request?: Request;
  loader?: CustomerPortfolioLoaderV1;
  toolName: string;
}): Promise<CustomerProfileProviderToolResultV1> {
  const subjectId = firstString(
    input.args.customer_id,
    input.args.customerId
  ).slice(0, 128);
  if (!subjectId) throw new Error("customer_id is required");
  const result = await (input.loader || defaultCustomerPortfolioLoader)({
    principal: input.principal,
    subjectId,
    request: input.request,
  });
  return attachBusinessResult({
    principal: input.principal,
    logicalContextId: "customer_portfolio",
    toolName: input.toolName,
    result,
    status: result.status,
    sourceEvidence: result.sourceEvidence,
    taskId: firstString(input.args.task_id, input.args.taskId),
  });
}

function projectionFieldValue(projection: JsonObject, path: string): unknown {
  const fields = Array.isArray(projection.fields)
    ? projection.fields.map(object)
    : [];
  return fields.find(field => field.path === path)?.value;
}

function legacyProfileCustomer(projection: JsonObject): JsonObject {
  return {
    customerId: firstString(projection.subjectId),
    id: firstString(projection.subjectId),
    name: firstString(projectionFieldValue(projection, "subject.displayName")),
    customerStatus: firstString(
      projectionFieldValue(projection, "subject.customerStatus")
    ),
    ageBand: firstString(
      projectionFieldValue(projection, "demographics.ageBand")
    ),
    occupationCategory: firstString(
      projectionFieldValue(projection, "demographics.occupationCategory")
    ),
    maskedPhone: firstString(
      projectionFieldValue(projection, "contact.maskedPhone")
    ),
    customerTier: firstString(
      projectionFieldValue(projection, "relationship.customerTier")
    ),
    riskPreference: firstString(
      projectionFieldValue(projection, "preferences.riskPreference")
    ),
    riskLevel: firstString(
      projectionFieldValue(projection, "risk.investmentRiskLevel")
    ),
    assessmentExpiresAt: firstString(
      projectionFieldValue(projection, "risk.investmentRiskValidUntil")
    ),
    aumBand: firstString(projectionFieldValue(projection, "wealth.aumBand")),
    dataAsOf: sourceAsOf(
      Array.isArray(projection.sourceEvidence)
        ? projection.sourceEvidence.map(item => ({
            asOf: firstString(object(item).asOf),
          }))
        : []
    ),
  };
}

function legacyDirectoryResult(
  result: CustomerDirectoryResultV1,
  roleTemplate: string
): JsonObject {
  const items = result.items.map(item => ({
    id: item.customerId,
    customerId: item.customerId,
    customer_id: item.customerId,
    name: item.displayName,
    customerName: item.displayName,
    accessScope: item.accessScope,
    businessDomain: item.businessDomain,
    relationshipRole: item.relationshipRole,
    preferredForWrite: item.preferredForWrite,
  }));
  if (roleTemplate === "insurance-advisor")
    return {
      items,
      total: result.total,
      offset: result.offset,
      limit: result.limit,
    };
  return {
    customers: items,
    items,
    total: result.total,
    page: Math.floor(result.offset / result.limit) + 1,
    pageSize: result.limit,
    data: { customers: items, total: result.total },
  };
}

async function executeLegacyTool(input: {
  principal: RuntimePrincipalV2;
  args: JsonObject;
  request?: Request;
  sourceLoader?: CustomerProfileSourceLoaderV1;
  bindingResolver?: CustomerProfileBindingResolverV1;
  directoryLoader?: CustomerDirectoryLoaderV1;
  portfolioLoader?: CustomerPortfolioLoaderV1;
  mode: CustomerProfileProviderModeV1;
  toolName: string;
}): Promise<CustomerProfileProviderToolResultV1> {
  if (input.toolName === LEGACY_PROFILE_TOOL_NAME) {
    const binding = bindingRequired()
      ? await (input.bindingResolver || defaultCustomerProfileBindingResolver)({
          principal: input.principal,
          stage: input.mode === "production" ? "production" : "shadow",
        })
      : undefined;
    return executeCustomerProfileProviderTool({
      principal: input.principal,
      args: input.args,
      sourceLoader: input.sourceLoader,
      request: input.request,
      binding,
      toolName: input.toolName,
    });
  }
  if (input.toolName === "wealth_assistant_context_probe") {
    const result = {
      schemaVersion: "ea.customer-context-legacy-probe.v1",
      allowed: input.principal.roleTemplate === "wealth-manager",
      data: {
        allowed: input.principal.roleTemplate === "wealth-manager",
        roleTemplate: input.principal.roleTemplate,
        source: "customer_context",
      },
    };
    return attachBusinessResult({
      principal: input.principal,
      logicalContextId: "customer_directory",
      toolName: input.toolName,
      result,
      status: result.allowed ? "READY" : "BLOCKED",
      sourceEvidence: [],
    });
  }
  if (
    ["wealth_assistant_customer_list", "list_customer_profiles"].includes(
      input.toolName
    )
  ) {
    const page = Math.max(1, Number(input.args.page || 1));
    const pageSize = Math.max(
      1,
      Math.min(100, Number(input.args.pageSize || input.args.limit || 20))
    );
    const args = {
      query: input.args.query,
      scope: input.args.scope,
      limit: pageSize,
      offset:
        input.toolName === "wealth_assistant_customer_list"
          ? (page - 1) * pageSize
          : input.args.offset,
    };
    const canonical = await executeDirectoryTool({
      principal: input.principal,
      args,
      request: input.request,
      loader: input.directoryLoader,
      toolName: input.toolName,
    });
    const parsed = parseToolPayload(canonical) as CustomerDirectoryResultV1;
    return {
      ...canonical,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            legacyDirectoryResult(parsed, input.principal.roleTemplate)
          ),
        },
      ],
    };
  }
  if (input.toolName === "get_customer_profile_by_name") {
    const name = firstString(input.args.name).slice(0, 200);
    if (!name) throw new Error("name is required");
    const directory = await executeDirectoryTool({
      principal: input.principal,
      args: { query: name, limit: 20, offset: 0 },
      request: input.request,
      loader: input.directoryLoader,
      toolName: input.toolName,
    });
    const items =
      (parseToolPayload(directory) as unknown as CustomerDirectoryResultV1)
        .items || [];
    const exact = items.filter(item => item.displayName === name);
    if (exact.length !== 1)
      throw new Error(
        exact.length ? "CUSTOMER_IDENTITY_AMBIGUOUS" : "CUSTOMER_NOT_FOUND"
      );
    const binding = bindingRequired()
      ? await (input.bindingResolver || defaultCustomerProfileBindingResolver)({
          principal: input.principal,
          stage: input.mode === "production" ? "production" : "shadow",
        })
      : undefined;
    const profile = await executeCustomerProfileProviderTool({
      principal: input.principal,
      args: { customer_id: exact[0].customerId, customer_name: name },
      sourceLoader: input.sourceLoader,
      request: input.request,
      binding,
      toolName: input.toolName,
    });
    const projection = parseToolPayload(profile);
    return {
      ...profile,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...legacyProfileCustomer(projection),
            governedProfile: projection,
          }),
        },
      ],
    };
  }
  if (input.toolName === "wealth_assistant_customer_detail") {
    const customerId = firstString(
      input.args.customer_id,
      input.args.customerId
    ).slice(0, 128);
    if (!customerId) throw new Error("customerId is required");
    const binding = bindingRequired()
      ? await (input.bindingResolver || defaultCustomerProfileBindingResolver)({
          principal: input.principal,
          stage: input.mode === "production" ? "production" : "shadow",
        })
      : undefined;
    const [profileResult, portfolioResult] = await Promise.all([
      executeCustomerProfileProviderTool({
        principal: input.principal,
        args: { customer_id: customerId },
        sourceLoader: input.sourceLoader,
        request: input.request,
        binding,
        toolName: input.toolName,
      }),
      executePortfolioTool({
        principal: input.principal,
        args: { customer_id: customerId },
        request: input.request,
        loader: input.portfolioLoader,
        toolName: input.toolName,
      }),
    ]);
    const profile = parseToolPayload(profileResult);
    const portfolio = parseToolPayload(
      portfolioResult
    ) as unknown as CustomerPortfolioResultV1;
    const customer = legacyProfileCustomer(profile);
    const compatibility = {
      schemaVersion: "ea.customer-context-legacy-wealth-detail.v1",
      customer,
      assetInfo: portfolio.summary,
      heldProducts: portfolio.holdings,
      maturedProducts: portfolio.maturities,
      data: {
        customer,
        assetInfo: portfolio.summary,
        heldProducts: portfolio.holdings,
        maturedProducts: portfolio.maturities,
      },
    };
    return {
      ...portfolioResult,
      content: [{ type: "text", text: JSON.stringify(compatibility) }],
      isError: profileResult.isError || portfolioResult.isError,
      _meta: {
        ...portfolioResult._meta,
        eaCustomerProfileReceipt: profileResult._meta?.eaContextReceipt,
      },
    };
  }
  throw new Error("Unknown Customer Context compatibility tool");
}

function rolePackId(roleTemplate: string): string {
  if (roleTemplate === "wealth-manager") return "linggan-bank.wealth-manager";
  if (roleTemplate === "insurance-advisor")
    return "linggan-insurance.insurance-advisor";
  return roleTemplate;
}

export const defaultCustomerProfileBindingResolver: CustomerProfileBindingResolverV1 =
  async input => {
    const bindings = await listContextSourceBindingContracts({
      organizationId: input.principal.organizationId,
      rolePackId: rolePackId(input.principal.roleTemplate),
      stage: input.stage,
    });
    const plan = resolveContextSources({
      organizationId: input.principal.organizationId,
      stage: input.stage,
      bindings,
      plan: {
        schema: "ea.context-need-plan.v1",
        planId: `customer-profile.${input.principal.roleTemplate}.${input.stage}`,
        planVersion: "1.0.0",
        rolePackId: rolePackId(input.principal.roleTemplate),
        roleTemplate: input.principal.roleTemplate,
        taskId: input.principal.taskId || "CUSTOMER-PROFILE-RUNTIME",
        needs: [
          {
            needId: "customer-profile",
            logicalAssetId: "customer_profile",
            contextType: "business_data",
            requiredness: "required",
            purpose: `${input.principal.roleTemplate} governed customer profile`,
            freshness: { mode: "latest" },
            requiredCapabilities: ["point_read"],
          },
        ],
      },
    });
    const resolution = plan.resolutions[0];
    if (resolution?.status !== "resolved" || !resolution.binding) {
      throw new Error(
        `CUSTOMER_PROFILE_BINDING_${resolution?.reasonCode || "UNRESOLVED"}`
      );
    }
    if (
      resolution.binding.providerType !== "mcp" ||
      resolution.binding.resourceRef !==
        "mcp://customer-profile/get_governed_customer_profile"
    ) {
      throw new Error("CUSTOMER_PROFILE_BINDING_TARGET_MISMATCH");
    }
    return resolution.binding;
  };

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function runtimePrincipal(req: Request) {
  const adoptId = trustedAdoptId(req);
  const adoption = adoptId ? await getClawByAdoptId(adoptId) : null;
  if (
    !adoption ||
    !["active", "expiring"].includes(String(adoption.status || ""))
  )
    throw new Error("active runtime adoption is required");
  const user = await getUserById(Number(adoption.userId || 0));
  if (!user) throw new Error("runtime user is unavailable");
  const principal = await resolveRuntimePrincipalV2({
    adoption,
    user,
    sessionId: trustedSessionId(req),
  });
  if (!principal.complete)
    throw new Error(
      `runtime principal is incomplete: ${principal.issues.join(",")}`
    );
  return principal.principal;
}

async function handleMessage(
  req: Request,
  message: JsonObject,
  options: RegisterCustomerProfileMcpOptionsV1
) {
  const id = message.id;
  const method = String(message.method || "");
  if (method === "initialize")
    return ok(id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
      instructions: [
        CUSTOMER_CONTEXT_DESCRIPTION,
        "Runtime role, purpose and organization come from signed identity and cannot be selected by tool arguments.",
        "New Skills must use the canonical tools; legacy names are compatibility aliases only.",
      ].join(" "),
    });
  if (method === "ping") return ok(id, {});
  if (method === "resources/list") return ok(id, { resources: [] });
  if (method === "prompts/list") return ok(id, { prompts: [] });
  if (method === "tools/list") {
    if (customerProfileProviderMode() === "disabled")
      return ok(id, { tools: [] });
    const principal = await runtimePrincipal(req);
    return ok(id, {
      tools: customerContextToolNames(principal.roleTemplate)
        .map(name => TOOL_BY_NAME.get(name))
        .filter(Boolean),
    });
  }
  if (method !== "tools/call")
    return err(id, -32601, `Method not found: ${method}`);
  const mode = customerProfileProviderMode();
  if (mode === "disabled")
    return err(id, -32010, "Customer Profile Provider is disabled");

  const params = object(message.params);
  const toolName = String(params.name || "");
  const args = object(params.arguments);
  const taskId = firstString(args.task_id, args.taskId).slice(0, 128);
  const principal = await runtimePrincipal(req);
  if (!customerContextToolNames(principal.roleTemplate).includes(toolName))
    return err(id, -32602, "Unknown or unauthorized Customer Context tool");
  let result: CustomerProfileProviderToolResultV1;
  if (toolName === DIRECTORY_TOOL.name) {
    result = await executeDirectoryTool({
      principal,
      args,
      request: req,
      loader: options.directoryLoader,
      toolName,
    });
  } else if (toolName === PROFILE_TOOL_NAME) {
    const binding = bindingRequired()
      ? await (
          options.bindingResolver || defaultCustomerProfileBindingResolver
        )({
          principal,
          stage: mode === "production" ? "production" : "shadow",
        })
      : undefined;
    result = await executeCustomerProfileProviderTool({
      principal,
      args,
      sourceLoader: options.sourceLoader,
      request: req,
      binding,
      toolName,
    });
  } else if (toolName === PORTFOLIO_TOOL.name) {
    result = await executePortfolioTool({
      principal,
      args,
      request: req,
      loader: options.portfolioLoader,
      toolName,
    });
  } else {
    result = await executeLegacyTool({
      principal,
      args,
      request: req,
      sourceLoader: options.sourceLoader,
      bindingResolver: options.bindingResolver,
      directoryLoader: options.directoryLoader,
      portfolioLoader: options.portfolioLoader,
      mode,
      toolName,
    });
  }
  const receipt = object(result._meta?.eaContextReceipt);
  const provided = object(receipt.provided);
  const businessData = Array.isArray(provided.businessData)
    ? provided.businessData.map(object)
    : [];
  await recordAuditBestEffort({
    action:
      mode === "production"
        ? "governance.customer_profile.runtime_provided"
        : "governance.customer_profile.shadow_evaluated",
    result: result.isError ? "denied" : "success",
    severity: result.isError ? "medium" : "info",
    actorType: "agent",
    actorUserId: principal.userId,
    actorRole: principal.roleTemplate,
    targetType: "logical_context",
    targetId:
      toolName === PORTFOLIO_TOOL.name
        ? "customer_portfolio"
        : toolName === DIRECTORY_TOOL.name
          ? "customer_directory"
          : "customer_profile",
    workspaceId: principal.workspaceId,
    agentInstanceId: principal.adoptionId,
    runtimeAgentId: principal.agentId,
    sessionId: principal.sessionId,
    toolName,
    source: "customer_context",
    ...auditRequest(req),
    metadata: {
      principalFingerprint: principalFingerprint(principal),
      taskId: taskId || null,
      receiptFingerprint:
        object(result._meta?.eaContextReceipt).receiptFingerprint || null,
      providerMode: mode,
      bindingId: firstString(businessData[0]?.bindingId) || null,
      contract: CUSTOMER_CONTEXT_CONTRACT,
      compatibilityAlias: !CUSTOMER_CONTEXT_CANONICAL_TOOLS.includes(
        toolName as (typeof CUSTOMER_CONTEXT_CANONICAL_TOOLS)[number]
      ),
    },
  });
  await persistTrustedContextReceiptResult({
    result,
    sessionId: principal.sessionId,
    adoptionId: principal.adoptionId,
    runtimeAgentId: principal.agentId,
    toolName,
  }).catch(() => false);
  return ok(id, result);
}

export function registerCustomerProfileMcpRoutes(
  app: Express,
  options: RegisterCustomerProfileMcpOptionsV1 = {}
): void {
  const routes = [
    {
      path: "/api/internal/customer-context/mcp",
      health: "/api/internal/customer-context/health",
      sessionPrefix: "customer-context",
    },
    {
      path: "/api/internal/customer-profile/mcp",
      health: "/api/internal/customer-profile/health",
      sessionPrefix: "customer-profile-compat",
    },
  ];
  const health = (req: Request, res: Response) => {
    if (!isAuthorizedInternalRequest(req))
      return res.status(401).json({ error: "unauthorized" });
    return res.json({
      status: "ok",
      name: SERVICE_NAME,
      displayName: CUSTOMER_CONTEXT_ADMIN_NAME,
      contract: CUSTOMER_CONTEXT_CONTRACT,
      version: SERVICE_VERSION,
      mode: customerProfileProviderMode(),
      assuranceMode: demoFactsEnabled() ? "demo" : "production",
      demoRuntimeAllowed:
        customerProfileProviderMode() === "production" &&
        enabled("EA_CUSTOMER_PROFILE_DEMO_RUNTIME_ENABLED"),
    });
  };
  for (const route of routes) {
    const audience = internalMcpAudience(route.path);
    app.get(route.health, health);
    app.get(route.path, async (req, res) => {
      if (!(await authorizeAndBindInternalRuntimeRequest(req, audience)))
        return res.status(401).json(err(null, -32001, "unauthorized"));
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader(
        "Mcp-Session-Id",
        `${route.sessionPrefix}-${trustedAdoptId(req)}`
      );
      res.flushHeaders?.();
      res.write(": customer context stream ready\n\n");
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);
      req.on("close", () => clearInterval(heartbeat));
    });
    app.delete(route.path, async (req, res) => {
      if (!(await authorizeAndBindInternalRuntimeRequest(req, audience)))
        return res.status(401).json(err(null, -32001, "unauthorized"));
      return res.status(204).end();
    });
    app.post(route.path, async (req, res) => {
      if (!(await authorizeAndBindInternalRuntimeRequest(req, audience)))
        return res.status(401).json(err(null, -32001, "unauthorized"));
      try {
        const body = req.body || {};
        const response = Array.isArray(body)
          ? (
              await Promise.all(
                body.map(item => handleMessage(req, object(item), options))
              )
            ).filter(Boolean)
          : await handleMessage(req, object(body), options);
        res.setHeader(
          "Mcp-Session-Id",
          `${route.sessionPrefix}-${trustedAdoptId(req)}`
        );
        return res.json(response);
      } catch (error) {
        return res
          .status(200)
          .json(
            err(
              object(req.body).id,
              -32000,
              error instanceof Error
                ? error.message
                : "Customer Context call failed"
            )
          );
      }
    });
  }
}
