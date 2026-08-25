import type { RuntimePrincipalV2 } from "./governance/contracts";
import { principalFingerprint } from "./governance/contracts";
import {
  customerProfileSourceFingerprint,
  normalizeCustomerProfileSource,
  type NormalizedCustomerProfileSourceV1,
} from "./customer-profile-source-adapters";
import {
  applyDemoWealthCustomerScenario,
  buildDemoWealthCustomerFacts,
  loadDemoInsuranceCustomerFacts,
} from "./customer-profile-demo-facts";
import {
  callInternalMcpTool,
  parseInternalMcpJsonResult,
} from "./internal-mcp-client";

type JsonObject = Record<string, unknown>;

export type CustomerProfileCompatibilityLoadResultV1 = {
  sources: NormalizedCustomerProfileSourceV1[];
  principalAuthorized: boolean;
  subjectInScope: boolean;
  notes: string[];
};

export type CustomerProfileEnterpriseSourceCallerV1 = (input: {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function stableId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .slice(0, 128);
}

function safeName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .slice(0, 200);
}

function errorText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map(item => object(item))
    .filter(item => item.type === "text")
    .map(item => String(item.text || ""))
    .join("\n")
    .trim()
    .slice(0, 1_000);
}

function parsedMcpResult(result: Record<string, unknown>): JsonObject {
  if (result.isError === true)
    throw new Error(
      `CUSTOMER_PROFILE_UPSTREAM_DENIED:${errorText(result) || "remote MCP denied the call"}`
    );
  return parseInternalMcpJsonResult(result);
}

export async function loadWealthCustomerProfileCompatibilitySource(input: {
  principal: RuntimePrincipalV2;
  subjectId: string;
  includeDemoFacts?: boolean;
}): Promise<CustomerProfileCompatibilityLoadResultV1> {
  const endpointUrl = String(
    process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp"
  ).trim();
  const probe = parsedMcpResult(
    await callInternalMcpTool({
      endpointUrl,
      toolName: "wealth_assistant_context_probe",
      args: {},
      agentId: input.principal.agentId,
      adoptId: input.principal.adoptionId,
      sessionId: input.principal.sessionId,
    })
  );
  const probeData = object(probe.data);
  const inScope =
    probe.allowed !== false && probeData.allowed !== false && !probe.error;
  if (!inScope) {
    return {
      sources: [],
      principalAuthorized: true,
      subjectInScope: false,
      notes: ["wealth source did not confirm customer service scope"],
    };
  }
  const payload = parsedMcpResult(
    await callInternalMcpTool({
      endpointUrl,
      toolName: "wealth_assistant_customer_detail",
      args: { customerId: input.subjectId },
      agentId: input.principal.agentId,
      adoptId: input.principal.adoptionId,
      sessionId: input.principal.sessionId,
    })
  );
  let source = normalizeCustomerProfileSource({
    sourceContractId: "wealth-assistant-customer-v2.1",
    payload,
    authorization: {
      inScope,
      organizationRef: input.principal.organizationId,
      principalRef: principalFingerprint(input.principal),
    },
  });
  source.assuranceLevel = "demo";
  source.resultFingerprint = customerProfileSourceFingerprint(source);
  if (input.includeDemoFacts) source = applyDemoWealthCustomerScenario(source);
  return {
    sources: [
      source,
      ...(input.includeDemoFacts
        ? [buildDemoWealthCustomerFacts({ subjectId: source.subjectId })]
        : []),
    ],
    principalAuthorized: true,
    subjectInScope: inScope,
    notes: input.includeDemoFacts
      ? ["missing Wealth governance facts were supplied by a synthetic GRACE Demo contributor"]
      : [],
  };
}

async function insuranceListItem(input: {
  subjectId: string;
  callEnterpriseTool: CustomerProfileEnterpriseSourceCallerV1;
}): Promise<JsonObject | null> {
  const pageSize = 50;
  const maxPages = 20;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = parsedMcpResult(
      await input.callEnterpriseTool({
        serverId: "insurance_customer_profile",
        toolName: "list_customer_profiles",
        args: { limit: pageSize, offset: page * pageSize },
      })
    );
    const items = array(payload.items);
    const matches = items.filter(item => stableId(item.id) === input.subjectId);
    if (matches.length > 1)
      throw new Error("CUSTOMER_PROFILE_SOURCE_IDENTITY_AMBIGUOUS");
    if (matches[0]) return matches[0];
    const total = Number(payload.total);
    if (!Number.isFinite(total) || items.length < pageSize) return null;
    if ((page + 1) * pageSize >= total) return null;
  }
  throw new Error("CUSTOMER_PROFILE_SOURCE_LIST_LIMIT_EXCEEDED");
}

export async function loadInsuranceCustomerProfileCompatibilitySource(input: {
  principal: RuntimePrincipalV2;
  subjectId: string;
  callEnterpriseTool: CustomerProfileEnterpriseSourceCallerV1;
  includeDemoFacts?: boolean;
}): Promise<CustomerProfileCompatibilityLoadResultV1> {
  const requestedSubjectId = stableId(input.subjectId);
  if (!requestedSubjectId)
    throw new Error("CUSTOMER_PROFILE_SUBJECT_UNRESOLVED");
  const listed = await insuranceListItem({
    subjectId: requestedSubjectId,
    callEnterpriseTool: input.callEnterpriseTool,
  });
  if (!listed) {
    return {
      sources: [],
      principalAuthorized: true,
      subjectInScope: false,
      notes: [
        "insurance Enterprise MCP scope did not return the requested stable customer id",
      ],
    };
  }
  const locatorName = safeName(listed.name);
  if (!locatorName) throw new Error("CUSTOMER_PROFILE_LEGACY_LOCATOR_MISSING");
  const payload = parsedMcpResult(
    await input.callEnterpriseTool({
      serverId: "insurance_customer_profile",
      toolName: "get_customer_profile_by_name",
      args: { name: locatorName },
    })
  );
  if (stableId(payload.id) !== requestedSubjectId)
    throw new Error("CUSTOMER_PROFILE_SOURCE_SUBJECT_MISMATCH");
  if (safeName(payload.name) !== locatorName)
    throw new Error("CUSTOMER_PROFILE_LEGACY_LOCATOR_MISMATCH");

  const legacy = normalizeCustomerProfileSource({
    sourceContractId: "insurance-customer-profile-demo-v1",
    payload,
    authorization: {
      inScope: true,
      organizationRef: input.principal.organizationId,
      principalRef: principalFingerprint(input.principal),
    },
  });
  legacy.assuranceLevel = "demo";
  legacy.resultFingerprint = customerProfileSourceFingerprint(legacy);
  const sources = [legacy];
  if (input.includeDemoFacts) {
    const supplement = loadDemoInsuranceCustomerFacts({
      subjectId: requestedSubjectId,
      organizationRef: input.principal.organizationId,
      principalRef: principalFingerprint(input.principal),
    });
    if (supplement) sources.push(supplement);
  }
  return {
    sources,
    principalAuthorized: true,
    subjectInScope: true,
    notes: [
      "legacy Insurance detail lookup was bound to a stable id selected from the governed Enterprise MCP result",
      "source remains Demo/Shadow and is not production ready",
      ...(input.includeDemoFacts
        ? [
            "missing Insurance policy facts were supplied by a synthetic GRACE Demo contributor",
          ]
        : []),
    ],
  };
}
