import type { RuntimePrincipalV2 } from "./governance/contracts";
import { principalFingerprint } from "./governance/contracts";
import {
  customerProfileSourceFingerprint,
  type NormalizedCustomerProfileFieldV1,
  type NormalizedCustomerProfileSourceV1,
} from "./customer-profile-source-adapters";
import type { CustomerProfileCompatibilityLoadResultV1 } from "./customer-profile-compatibility-adapter";

type JsonObject = Record<string, unknown>;

export type TwentyCustomerProfileRecordV1 = {
  graceCustomerId: string;
  displayName: string;
  customerStatus: string;
  tenantId: string;
  ownerUserId: string;
  businessAsOf: string;
  maskedPhone?: string;
  profileType: string;
  detailSchemaVersion: string;
  demographics: JsonObject;
  preferences: JsonObject;
  insuranceFacts: JsonObject;
  detail: JsonObject;
  fieldProvenance: Record<
    string,
    { sourceSystem?: string; asOf?: string; sourceField?: string }
  >;
};

export type TwentyCustomerProfileRecordLoaderV1 = (input: {
  graceCustomerId: string;
  principal: RuntimePrincipalV2;
}) => Promise<{
  record: TwentyCustomerProfileRecordV1 | null;
  principalAuthorized: boolean;
  subjectInScope: boolean;
  authorizationEvidenceId: string;
} | null>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function strings(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(item => String(item).trim())
      .filter(Boolean)
      .slice(0, 20);
  return String(value ?? "")
    .split(/[,，;；\n]/u)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function ageBand(value: unknown): string | undefined {
  const age = Number(value);
  if (!Number.isInteger(age) || age < 0 || age > 130) return undefined;
  if (age < 18) return "under_18";
  if (age < 30) return "18_29";
  if (age < 45) return "30_44";
  if (age < 60) return "45_59";
  return "60_plus";
}

function annualMileageBand(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const multiplier = text.includes("万") ? 10_000 : 1;
  const values = Array.from(text.matchAll(/\d+(?:\.\d+)?/gu)).map(
    match => Number(match[0]) * multiplier
  );
  if (!values.length) return undefined;
  const mileage = values.reduce((sum, item) => sum + item, 0) / values.length;
  if (mileage < 5_000) return "lt_5k";
  if (mileage < 10_000) return "5k_10k";
  if (mileage < 20_000) return "10k_20k";
  return "gte_20k";
}

function maskedVehicles(value: unknown): JsonObject[] | undefined {
  const summary = object(value);
  const vehicles = Array.isArray(summary.vehicles)
    ? summary.vehicles.map(object)
    : [];
  if (!vehicles.length && !Number.isFinite(Number(summary.vehicleCount)))
    return undefined;
  return vehicles.slice(0, 20).map(vehicle => ({
    vehicleRef: firstString(vehicle.vehicleIdDesensitized).slice(0, 64),
    brand: firstString(vehicle.brand).slice(0, 80),
    model: firstString(vehicle.model).slice(0, 80),
    year: Number.isInteger(Number(vehicle.year))
      ? Number(vehicle.year)
      : undefined,
    energyType: firstString(vehicle.energyType).slice(0, 40),
    usage: firstString(vehicle.usage).slice(0, 80),
  }));
}

function asIso(value: unknown): string | undefined {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

export function normalizeTwentyCustomerProfileSource(input: {
  record: TwentyCustomerProfileRecordV1;
  principal: RuntimePrincipalV2;
  subjectInScope: boolean;
  observedAt?: string;
  productionReady?: boolean;
}): NormalizedCustomerProfileSourceV1 {
  const observedAt = input.observedAt || new Date().toISOString();
  const asOf = asIso(input.record.businessAsOf) || observedAt;
  const sourceRecordRef = `twenty_crm:${input.record.graceCustomerId}`;
  const fields: NormalizedCustomerProfileFieldV1[] = [];
  const add = (path: string, value: unknown, sourceField = path) => {
    if (value === undefined || value === null || value === "") return;
    const evidence = input.record.fieldProvenance[sourceField];
    fields.push({
      path,
      value,
      provenance: {
        sourceSystem: firstString(evidence?.sourceSystem, "twenty_crm"),
        sourceRecordRef,
        asOf: asIso(evidence?.asOf) || asOf,
        observedAt,
        mappingRuleVersion: "twenty-customer-profile.v1",
      },
    });
  };

  const demographics = object(input.record.demographics);
  const preferences = object(input.record.preferences);
  const facts = object(input.record.insuranceFacts);
  const detail = object(input.record.detail);
  add("subject.subjectId", input.record.graceCustomerId);
  add("subject.subjectType", "individual_customer");
  add("subject.displayName", input.record.displayName);
  add("subject.customerStatus", input.record.customerStatus);
  add("serviceScope.inScope", input.subjectInScope);
  add("serviceScope.ownerOrganizationRef", input.principal.organizationId);
  add("serviceScope.ownerPrincipalRef", principalFingerprint(input.principal));
  add("demographics.age", demographics.age);
  add(
    "demographics.ageBand",
    firstString(demographics.ageBand, ageBand(demographics.age))
  );
  add(
    "demographics.occupationCategory",
    firstString(demographics.occupationCategory, demographics.occupation)
  );
  add("demographics.city", demographics.city);
  add("contact.maskedPhone", input.record.maskedPhone, "maskedPhone");
  add(
    "relationship.recentContactSummary",
    facts.recentContactSummary,
    "recentContactSummary"
  );
  const confirmedNeeds = strings(facts.confirmedNeeds);
  if (confirmedNeeds.length)
    add("relationship.confirmedNeeds", confirmedNeeds, "confirmedNeeds");
  add("preferences.riskPreference", preferences.riskPreference);
  add("preferences.budgetConcern", preferences.budgetConcern, "budgetConcern");
  add(
    "preferences.servicePreference",
    preferences.servicePreference,
    "servicePreference"
  );
  add(
    "preferences.communicationPreference",
    preferences.communicationPreference,
    "communicationPreference"
  );
  add("relationship.customerTier", detail.customerTier, "detail.customerTier");
  const riskAssessment = object(detail.riskAssessment);
  add(
    "risk.investmentRiskLevel",
    riskAssessment.riskLevel,
    "detail.riskAssessment"
  );
  add(
    "risk.investmentRiskValidUntil",
    asIso(riskAssessment.validUntil),
    "detail.riskAssessment"
  );
  const assetAllocation = object(detail.assetAllocationSummary);
  add(
    "wealth.aumBand",
    assetAllocation.aumBand,
    "detail.assetAllocationSummary"
  );
  const wealthSummary = firstString(assetAllocation.aumBand)
    ? `资产规模区间：${firstString(assetAllocation.aumBand)}`
    : undefined;
  add(
    "wealth.assetAllocationSummary",
    wealthSummary,
    "detail.assetAllocationSummary"
  );
  const vehicles = maskedVehicles(detail.vehicleSummary);
  if (vehicles)
    add("insurance.vehicleSummary", vehicles, "detail.vehicleSummary");
  add(
    "insurance.annualMileageBand",
    annualMileageBand(detail.annualMileage),
    "detail.annualMileage"
  );
  add(
    "insurance.drivingRiskSummary",
    detail.drivingRecord,
    "detail.drivingRecord"
  );
  add("insurance.renewalAt", asIso(facts.renewalAt), "renewalAt");
  add("insurance.renewalStatus", facts.renewalStatus, "renewalStatus");
  add(
    "insurance.currentCoverageSummary",
    facts.currentCoverageSummary,
    "currentCoverageSummary"
  );
  add(
    "insurance.claimsRiskSummary",
    facts.claimsRiskSummary,
    "claimsRiskSummary"
  );
  const protectionGaps = strings(facts.protectionGaps);
  if (protectionGaps.length)
    add("insurance.protectionGaps", protectionGaps, "protectionGaps");

  const source: NormalizedCustomerProfileSourceV1 = {
    sourceContractId: "twenty-crm-customer-v1",
    sourceSystem: "twenty_crm",
    subjectId: input.record.graceCustomerId,
    sourceRecordRef,
    asOf,
    observedAt,
    productionReady: input.productionReady === true,
    assuranceLevel: input.productionReady ? "production" : "candidate",
    providerGaps: input.productionReady
      ? []
      : ["Twenty CRM source is in Shadow and has not passed Promotion Review."],
    fields,
    resultFingerprint: "",
  };
  source.resultFingerprint = customerProfileSourceFingerprint(source);
  return source;
}

export async function loadTwentyCustomerProfileCompatibilitySource(input: {
  principal: RuntimePrincipalV2;
  subjectId: string;
  recordLoader: TwentyCustomerProfileRecordLoaderV1;
  productionReady?: boolean;
}): Promise<CustomerProfileCompatibilityLoadResultV1> {
  const loaded = await input.recordLoader({
    graceCustomerId: input.subjectId,
    principal: input.principal,
  });
  if (!loaded) {
    return {
      sources: [],
      principalAuthorized: true,
      subjectInScope: false,
      notes: ["Twenty CRM did not return the requested Global Customer ID."],
    };
  }
  if (!loaded.record) {
    return {
      sources: [],
      principalAuthorized: loaded.principalAuthorized,
      subjectInScope: loaded.subjectInScope,
      notes: [
        loaded.principalAuthorized
          ? "Twenty CRM subject is outside the principal scope."
          : "Twenty CRM principal is not authorized for this customer context.",
        `Row authorization evidence: ${loaded.authorizationEvidenceId.slice(0, 128)}`,
      ],
    };
  }
  if (loaded.record.graceCustomerId !== input.subjectId)
    throw new Error("CUSTOMER_CRM_SOURCE_SUBJECT_MISMATCH");
  return {
    sources: [
      normalizeTwentyCustomerProfileSource({
        record: loaded.record,
        principal: input.principal,
        subjectInScope: loaded.subjectInScope,
        productionReady: input.productionReady,
      }),
    ],
    principalAuthorized: loaded.principalAuthorized,
    subjectInScope: loaded.subjectInScope,
    notes: [
      `Twenty CRM access evaluated for principal ${principalFingerprint(input.principal)}`,
      `Row authorization evidence: ${loaded.authorizationEvidenceId.slice(0, 128)}`,
      "Runtime purpose projection remains owned by the EA Customer Profile Provider.",
    ],
  };
}
