import { governanceFingerprint } from "./governance/contracts";

type JsonObject = Record<string, unknown>;

export type WealthCustomerContextAssembly = {
  customer: JsonObject;
  evidence: {
    customerId: string;
    profileDataAsOf: string;
    portfolioDataAsOf: string;
    profileResultFingerprint: string;
    portfolioResultFingerprint: string;
    combinedResultFingerprint: string;
  };
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
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

function valueAtPath(root: JsonObject, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[segment];
  }
  return current;
}

function setAtPath(root: JsonObject, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = root;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const existing = object(current[segment]);
    current[segment] = existing;
    current = existing;
  });
}

function projectionFields(payload: JsonObject): JsonObject | null {
  if (payload.logicalContextId !== "customer_profile" || !Array.isArray(payload.fields)) return null;
  const result: JsonObject = {};
  for (const row of payload.fields) {
    const field = object(row);
    const path = firstString(field.path);
    if (path) setAtPath(result, path, field.value);
  }
  return result;
}

function governedProfile(payload: JsonObject): JsonObject | null {
  const fields = projectionFields(payload);
  if (!fields) return null;
  return {
    customerId: firstString(valueAtPath(fields, "subject.subjectId"), payload.subjectId),
    name: firstString(valueAtPath(fields, "subject.displayName")),
    customerStatus: firstString(valueAtPath(fields, "subject.customerStatus")),
    ageBand: firstString(valueAtPath(fields, "demographics.ageBand")),
    occupationCategory: firstString(valueAtPath(fields, "demographics.occupationCategory")),
    maskedPhone: firstString(valueAtPath(fields, "contact.maskedPhone")),
    customerTier: firstString(valueAtPath(fields, "relationship.customerTier")),
    lastContactAt: firstString(valueAtPath(fields, "relationship.lastContactAt")),
    recentContactSummary: firstString(valueAtPath(fields, "relationship.recentContactSummary")),
    confirmedNeeds: valueAtPath(fields, "relationship.confirmedNeeds"),
    riskPreference: firstString(valueAtPath(fields, "preferences.riskPreference")),
    investmentHorizon: firstString(valueAtPath(fields, "preferences.investmentHorizon")),
    liquidityNeeds: firstString(valueAtPath(fields, "preferences.liquidityNeeds")),
    communicationPreference: firstString(valueAtPath(fields, "preferences.communicationPreference")),
    riskLevel: firstString(valueAtPath(fields, "risk.investmentRiskLevel")),
    assessmentExpiresAt: firstString(valueAtPath(fields, "risk.investmentRiskValidUntil")),
    complianceFlags: valueAtPath(fields, "risk.complianceFlags"),
    aumBand: firstString(valueAtPath(fields, "wealth.aumBand")),
    assetAllocationSummary: firstString(valueAtPath(fields, "wealth.assetAllocationSummary")),
    governedProfile: fields,
    profileGovernance: {
      projectionId: payload.projectionId,
      projectionVersion: payload.projectionVersion,
      purposeId: payload.purposeId,
      status: payload.status,
      reasonCodes: payload.reasonCodes,
      filteredFieldCount: payload.filteredFieldCount,
    },
  };
}

function profileAsOf(payload: JsonObject): string {
  const sourceEvidence = Array.isArray(payload.sourceEvidence) ? payload.sourceEvidence.map(object) : [];
  const customer = customerObject(payload);
  return sourceEvidence
    .map((item) => firstString(item.asOf))
    .filter(Boolean)
    .sort()
    .at(-1) || firstString(
      payload.dataAsOf,
      payload.asOf,
      payload.updatedAt,
      customer.dataAsOf,
      customer.data_as_of,
      customer.updatedAt,
      customer.updated_at,
      payload.generatedAt,
    );
}

function portfolioData(payload: JsonObject): JsonObject {
  const data = object(payload.data);
  const source = Object.keys(data).length ? data : payload;
  const selected: JsonObject = {};
  for (const key of [
    "activityInfo",
    "assetInfo",
    "summary",
    "heldProducts",
    "maturedProducts",
    "expiringProducts",
    "holdings",
    "maturities",
    "positions",
    "assets",
  ]) {
    if (source[key] !== undefined) selected[key] = source[key];
  }
  return selected;
}

function customerId(customer: JsonObject): string {
  return firstString(
    customer.customerId,
    customer.customer_id,
    customer.subjectId,
    customer.CUST_NO,
    customer.id,
  );
}

export function assembleWealthCustomerContext(input: {
  expectedCustomerId: string;
  profilePayload: JsonObject;
  portfolioPayload: JsonObject;
  allowCanonicalAliasResolution?: boolean;
}): WealthCustomerContextAssembly {
  const governed = governedProfile(input.profilePayload);
  const rawProfile = customerObject(input.profilePayload);
  const profile = governed || rawProfile;
  const portfolioCustomer = customerObject(input.portfolioPayload);
  const returnedProfileId = customerId(profile);
  const returnedPortfolioId = customerId(portfolioCustomer);
  if (!returnedProfileId) {
    throw new Error("客户画像来源返回的客户标识与请求不一致");
  }
  if (!returnedPortfolioId) {
    throw new Error("客户持仓来源返回的客户标识与请求不一致");
  }
  const exactIdentity = returnedProfileId === input.expectedCustomerId
    && returnedPortfolioId === input.expectedCustomerId;
  const governedAliasIdentity = input.allowCanonicalAliasResolution === true
    && returnedProfileId === returnedPortfolioId
    && /^CUST-[0-9]{6}$/u.test(returnedProfileId);
  if (!exactIdentity && !governedAliasIdentity) {
    throw new Error("客户画像与持仓来源未解析到同一客户标识");
  }

  const portfolio = portfolioData(input.portfolioPayload);
  const profileDataAsOf = profileAsOf(input.profilePayload);
  const portfolioDataAsOf = firstString(
    profileAsOf(input.portfolioPayload),
    input.portfolioPayload.dataAsOf,
    input.portfolioPayload.asOf,
    input.portfolioPayload.updatedAt,
    object(input.portfolioPayload.data).updatedAt,
    portfolioCustomer.dataAsOf,
    portfolioCustomer.data_as_of,
    portfolioCustomer.updatedAt,
    portfolioCustomer.updated_at,
  );
  const customer = {
    ...profile,
    dataAsOf: portfolioDataAsOf || profileDataAsOf,
    ...(Object.keys(portfolio).length ? { portfolio } : {}),
  };
  const profileResultFingerprint = governanceFingerprint(input.profilePayload);
  const portfolioResultFingerprint = governanceFingerprint(
    Object.keys(portfolio).length ? portfolio : input.portfolioPayload,
  );
  return {
    customer,
    evidence: {
      customerId: returnedProfileId,
      profileDataAsOf,
      portfolioDataAsOf,
      profileResultFingerprint,
      portfolioResultFingerprint,
      combinedResultFingerprint: governanceFingerprint({
        profileResultFingerprint,
        portfolioResultFingerprint,
      }),
    },
  };
}

export async function loadWealthCustomerContext(input: {
  customerId: string;
  loadCustomer?: (customerId: string) => Promise<JsonObject>;
  loadCustomerProfile?: (customerId: string) => Promise<JsonObject>;
  loadCustomerPortfolio?: (customerId: string) => Promise<JsonObject>;
}): Promise<WealthCustomerContextAssembly> {
  if (input.loadCustomerProfile && input.loadCustomerPortfolio) {
    const [profilePayload, portfolioPayload] = await Promise.all([
      input.loadCustomerProfile(input.customerId),
      input.loadCustomerPortfolio(input.customerId),
    ]);
    return assembleWealthCustomerContext({
      expectedCustomerId: input.customerId,
      profilePayload,
      portfolioPayload,
      allowCanonicalAliasResolution: true,
    });
  }
  if (!input.loadCustomer) throw new Error("客户画像与持仓来源未配置");
  const payload = await input.loadCustomer(input.customerId);
  return assembleWealthCustomerContext({
    expectedCustomerId: input.customerId,
    profilePayload: payload,
    portfolioPayload: payload,
  });
}
