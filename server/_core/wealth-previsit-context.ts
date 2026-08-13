import { governanceFingerprint, type RuntimePrincipalV2 } from "./governance/contracts";
import type { WealthPrevisitKnowledgeBasis } from "./wealth-policy-source";

type JsonObject = Record<string, unknown>;

export type WealthPrevisitContextResult = {
  schema: "ea.wealth-previsit-context.v1";
  status: "ready" | "degraded";
  customer: JsonObject;
  knowledgeBasis: WealthPrevisitKnowledgeBasis;
  evidence: {
    customerId: string;
    customerDataAsOf: string;
    customerResultFingerprint: string;
    scopeVerified: boolean;
  };
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function customerObject(payload: JsonObject): JsonObject {
  const data = object(payload.data);
  return Object.keys(object(payload.customer)).length
    ? object(payload.customer)
    : Object.keys(object(data.customer)).length
      ? object(data.customer)
      : Object.keys(data).length ? data : payload;
}

export async function prepareWealthPrevisitContext(input: {
  principal: RuntimePrincipalV2;
  customerId: string;
  dependencies: {
    probeIdentity(): Promise<JsonObject>;
    loadCustomer(customerId: string): Promise<JsonObject>;
    resolveKnowledge(): Promise<WealthPrevisitKnowledgeBasis>;
  };
}): Promise<WealthPrevisitContextResult> {
  const [probe, customerPayload, knowledgeBasis] = await Promise.all([
    input.dependencies.probeIdentity(),
    input.dependencies.loadCustomer(input.customerId),
    input.dependencies.resolveKnowledge(),
  ]);
  const customer = customerObject(customerPayload);
  const returnedCustomerId = firstString(customer.customerId, customer.customer_id, customer.id);
  if (!returnedCustomerId || returnedCustomerId !== input.customerId) {
    throw new Error("客户 MCP 返回的客户标识与请求不一致");
  }
  const probeData = object(probe.data);
  const probeAllowed = probe.allowed !== false && probeData.allowed !== false && !probe.error;
  if (!probeAllowed) throw new Error("客户 MCP 未确认当前岗位的数据范围");
  const customerDataAsOf = firstString(
    customer.dataAsOf,
    customer.data_as_of,
    customer.updatedAt,
    customer.updated_at,
    customerPayload.updatedAt,
  );
  return {
    schema: "ea.wealth-previsit-context.v1",
    status: knowledgeBasis.status === "ready" && customerDataAsOf ? "ready" : "degraded",
    customer,
    knowledgeBasis,
    evidence: {
      customerId: returnedCustomerId,
      customerDataAsOf,
      customerResultFingerprint: governanceFingerprint(customer),
      scopeVerified: true,
    },
  };
}
