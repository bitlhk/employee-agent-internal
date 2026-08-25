import type { RuntimePrincipalV2 } from "./governance/contracts";
import type { WealthPrevisitKnowledgeBasis } from "./wealth-policy-source";
import { loadWealthCustomerContext } from "./wealth-customer-context";

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
    profileDataAsOf: string;
    portfolioDataAsOf: string;
    profileResultFingerprint: string;
    portfolioResultFingerprint: string;
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

export async function prepareWealthPrevisitContext(input: {
  principal: RuntimePrincipalV2;
  customerId: string;
  dependencies: {
    probeIdentity(): Promise<JsonObject>;
    loadCustomer?(customerId: string): Promise<JsonObject>;
    loadCustomerProfile?(customerId: string): Promise<JsonObject>;
    loadCustomerPortfolio?(customerId: string): Promise<JsonObject>;
    resolveKnowledge(): Promise<WealthPrevisitKnowledgeBasis>;
  };
}): Promise<WealthPrevisitContextResult> {
  const [probe, customerContext, knowledgeBasis] = await Promise.all([
    input.dependencies.probeIdentity(),
    loadWealthCustomerContext({
      customerId: input.customerId,
      loadCustomer: input.dependencies.loadCustomer,
      loadCustomerProfile: input.dependencies.loadCustomerProfile,
      loadCustomerPortfolio: input.dependencies.loadCustomerPortfolio,
    }),
    input.dependencies.resolveKnowledge(),
  ]);
  const customer = customerContext.customer;
  const probeData = object(probe.data);
  const probeAllowed = probe.allowed !== false && probeData.allowed !== false && !probe.error;
  if (!probeAllowed) throw new Error("客户 MCP 未确认当前岗位的数据范围");
  const customerDataAsOf = firstString(
    customerContext.evidence.portfolioDataAsOf,
    customerContext.evidence.profileDataAsOf,
  );
  return {
    schema: "ea.wealth-previsit-context.v1",
    status: knowledgeBasis.status === "ready" && customerDataAsOf ? "ready" : "degraded",
    customer,
    knowledgeBasis,
    evidence: {
      customerId: customerContext.evidence.customerId,
      customerDataAsOf,
      customerResultFingerprint: customerContext.evidence.combinedResultFingerprint,
      profileDataAsOf: customerContext.evidence.profileDataAsOf,
      portfolioDataAsOf: customerContext.evidence.portfolioDataAsOf,
      profileResultFingerprint: customerContext.evidence.profileResultFingerprint,
      portfolioResultFingerprint: customerContext.evidence.portfolioResultFingerprint,
      scopeVerified: true,
    },
  };
}
