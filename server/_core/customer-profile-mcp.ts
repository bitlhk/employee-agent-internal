import { createHash } from "node:crypto";
import type { Express, Request } from "express";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import {
  governanceFingerprint,
  principalFingerprint,
} from "./governance/contracts";
import {
  attachContextReceipt,
  buildContextReceipt,
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
import { executeEnterpriseMcpGatewayTool } from "./enterprise-mcp-gateway";
import { getClawByAdoptId, getUserById } from "../db";
import {
  projectCustomerProfile,
  type CustomerProfileProviderInputV1,
} from "./customer-profile-provider";
import { recordAuditBestEffort, auditRequest } from "./audit-events";

const SERVICE_NAME = "customer-profile-provider";
const SERVICE_VERSION = "1.1.0";
const TOOL_NAME = "get_governed_customer_profile";

type JsonObject = Record<string, unknown>;

export type CustomerProfileSourceLoaderV1 = (input: {
  principal: RuntimePrincipalV2;
  subjectId: string;
  customerName?: string;
  request?: Request;
}) => Promise<CustomerProfileCompatibilityLoadResultV1>;

export type CustomerProfileProviderToolResultV1 = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

type RegisterCustomerProfileMcpOptionsV1 = {
  sourceLoader?: CustomerProfileSourceLoaderV1;
};

const TOOL = {
  name: TOOL_NAME,
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

function shadowEnabled(): boolean {
  return (
    String(process.env.EA_CUSTOMER_PROFILE_PROVIDER_SHADOW_ENABLED || "")
      .trim()
      .toLowerCase() === "true"
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

function remediationFor(reasonCodes: string[]): string[] {
  const remediation: string[] = [];
  if (reasonCodes.includes("CUSTOMER_PROFILE_PROVIDER_NOT_PRODUCTION_READY"))
    remediation.push(
      "Complete source authorization, authoritative asOf and purpose-aware field projection before promotion."
    );
  if (reasonCodes.includes("CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING"))
    remediation.push(
      "Provide the task-required governed customer fields with field-level provenance."
    );
  if (reasonCodes.includes("SUBJECT_OUT_OF_SCOPE"))
    remediation.push(
      "Select a customer in the current principal and purpose service scope."
    );
  if (reasonCodes.includes("PRINCIPAL_NOT_AUTHORIZED"))
    remediation.push(
      "Complete the role and customer-source authorization review."
    );
  if (!remediation.length)
    remediation.push(
      "Resolve the recorded Customer Profile governance reason before retrying."
    );
  return remediation;
}

function providerReceipt(input: {
  principal: RuntimePrincipalV2;
  projection: ReturnType<typeof projectCustomerProfile>;
}) {
  const { projection, principal } = input;
  const provided =
    projection.status === "BLOCKED"
      ? []
      : [
          {
            sourceSystem: "enterprise_customer_profile_provider",
            label: `${projection.purposeId} governed customer profile`,
            entityRef: customerEntityRef(projection.subjectId),
            asOf: sourceAsOf(projection.sourceEvidence),
            resultFingerprint: governanceFingerprint(projection),
            logicalAssetId: "customer_profile",
            providerType: "mcp" as const,
          },
        ];
  const allowed = projection.status !== "BLOCKED";
  return buildContextReceipt({
    taskId: projection.taskId || "CUSTOMER-PROFILE-SHADOW",
    taskLabel: "Governed Customer Profile Projection",
    principalFingerprint: principalFingerprint(principal),
    provided: {
      knowledge: [],
      businessData: provided,
      memory: [],
      capabilities: [
        {
          capabilityId: TOOL_NAME,
          label: "Governed Customer Profile read",
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
        capabilityId: TOOL_NAME,
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
            message:
              "Customer fields were not provided because the governed projection gate did not pass.",
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
  loaded: CustomerProfileCompatibilityLoadResultV1
): CustomerProfileProviderToolResultV1 {
  const receipt = providerReceipt({ projection, principal });
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
    if (input.principal.roleTemplate === "wealth-manager")
      return loadWealthCustomerProfileCompatibilitySource(input);
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
    requestedSubjectId: subjectId,
    principalFingerprint: principalFingerprint(input.principal),
    principalAuthorized: loaded.principalAuthorized,
    subjectInScope: loaded.subjectInScope,
    sources: loaded.sources,
  };
  return textResult(
    projectCustomerProfile(projectionInput),
    input.principal,
    loaded
  );
}

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
  sourceLoader?: CustomerProfileSourceLoaderV1
) {
  const id = message.id;
  const method = String(message.method || "");
  if (method === "initialize")
    return ok(id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
      instructions:
        "Shadow-only governed Customer Profile projections. Runtime role and purpose come from signed identity.",
    });
  if (method === "ping") return ok(id, {});
  if (method === "resources/list") return ok(id, { resources: [] });
  if (method === "prompts/list") return ok(id, { prompts: [] });
  if (method === "tools/list")
    return ok(id, { tools: shadowEnabled() ? [TOOL] : [] });
  if (method !== "tools/call")
    return err(id, -32601, `Method not found: ${method}`);
  if (!shadowEnabled())
    return err(id, -32010, "Customer Profile Provider shadow is disabled");

  const params = object(message.params);
  if (String(params.name || "") !== TOOL_NAME)
    return err(id, -32602, "Unknown Customer Profile tool");
  const args = object(params.arguments);
  const taskId = firstString(args.task_id, args.taskId).slice(0, 128);
  const principal = await runtimePrincipal(req);
  const result = await executeCustomerProfileProviderTool({
    principal,
    args,
    sourceLoader,
    request: req,
  });
  await recordAuditBestEffort({
    action: "governance.customer_profile.shadow_evaluated",
    result: result.isError ? "denied" : "success",
    severity: result.isError ? "medium" : "info",
    actorType: "agent",
    actorUserId: principal.userId,
    actorRole: principal.roleTemplate,
    targetType: "logical_context",
    targetId: "customer_profile",
    workspaceId: principal.workspaceId,
    agentInstanceId: principal.adoptionId,
    runtimeAgentId: principal.agentId,
    sessionId: principal.sessionId,
    toolName: TOOL_NAME,
    source: "customer_profile_provider",
    ...auditRequest(req),
    metadata: {
      principalFingerprint: principalFingerprint(principal),
      taskId: taskId || null,
      receiptFingerprint:
        object(result._meta?.eaContextReceipt).receiptFingerprint || null,
    },
  });
  return ok(id, result);
}

export function registerCustomerProfileMcpRoutes(
  app: Express,
  options: RegisterCustomerProfileMcpOptionsV1 = {}
): void {
  const audience = internalMcpAudience("/api/internal/customer-profile/mcp");
  app.get("/api/internal/customer-profile/health", (req, res) => {
    if (!isAuthorizedInternalRequest(req))
      return res.status(401).json({ error: "unauthorized" });
    return res.json({
      status: "ok",
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
      mode: shadowEnabled() ? "shadow" : "disabled",
    });
  });

  app.get("/api/internal/customer-profile/mcp", async (req, res) => {
    if (!(await authorizeAndBindInternalRuntimeRequest(req, audience)))
      return res.status(401).json(err(null, -32001, "unauthorized"));
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Mcp-Session-Id", `customer-profile-${trustedAdoptId(req)}`);
    res.flushHeaders?.();
    res.write(": customer profile stream ready\n\n");
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);
    req.on("close", () => clearInterval(heartbeat));
  });

  app.delete("/api/internal/customer-profile/mcp", async (req, res) => {
    if (!(await authorizeAndBindInternalRuntimeRequest(req, audience)))
      return res.status(401).json(err(null, -32001, "unauthorized"));
    return res.status(204).end();
  });

  app.post("/api/internal/customer-profile/mcp", async (req, res) => {
    if (!(await authorizeAndBindInternalRuntimeRequest(req, audience)))
      return res.status(401).json(err(null, -32001, "unauthorized"));
    try {
      const body = req.body || {};
      const response = Array.isArray(body)
        ? (
            await Promise.all(
              body.map(item =>
                handleMessage(req, object(item), options.sourceLoader)
              )
            )
          ).filter(Boolean)
        : await handleMessage(req, object(body), options.sourceLoader);
      res.setHeader(
        "Mcp-Session-Id",
        `customer-profile-${trustedAdoptId(req)}`
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
              : "Customer Profile call failed"
          )
        );
    }
  });
}
