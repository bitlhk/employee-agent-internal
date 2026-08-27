import { createHash } from "node:crypto";
import type { CustomerCrmDomainProfileSchemaSetV1 } from "../../shared/customer-crm-contract";
import { loadCustomerCrmContracts } from "./customer-crm-contracts";

type JsonObject = Record<string, unknown>;

export type InsuranceCustomerImportSourceV1 = {
  id: string | number;
  name: string;
  profile_type: string;
  age?: number;
  gender?: string;
  occupation?: string;
  city?: string;
  risk_preference?: string;
  customer_status?: string;
  renewalAt?: string | null;
  renewalStatus?: string;
  currentCoverageSummary?: string;
  claimsRiskSummary?: string;
  recentContactSummary?: string;
  confirmedNeeds?: string;
  budgetConcern?: string;
  servicePreference?: string;
  communicationPreference?: string;
  businessAsOf?: string;
  provenance?: Record<string, { source?: string; updatedAt?: string }>;
  detail?: JsonObject;
  bio?: string;
  protection_gap?: string;
  contact_strategy?: string;
  tenant_id?: string;
  owner_user_id?: string | number;
};

export type CustomerCrmImportBundleV1 = {
  schemaVersion: "ea.customer-crm-import-bundle.v1";
  generatedAt: string;
  sourceSystem: "insurance_customer_profile";
  customers: Array<{
    graceCustomerId: string;
    displayName: string;
    customerStatus: string;
    tenantId: string;
    ownerUserId: string;
    businessAsOf: string;
  }>;
  sourceLinks: Array<{
    graceCustomerId: string;
    sourceSystem: string;
    sourceCustomerId: string;
    sourceTenantId: string;
    sourceRecordFingerprint: string;
  }>;
  domainProfiles: Array<{
    graceCustomerId: string;
    profileType: string;
    detailSchemaVersion: string;
    demographics: JsonObject;
    preferences: JsonObject;
    insuranceFacts: JsonObject;
    detail: JsonObject;
    fieldProvenance: Record<
      string,
      {
        sourceSystem: string;
        asOf: string;
        sourceField: string;
      }
    >;
    runtimeStatus: "candidate";
  }>;
  suggestions: Array<{
    graceCustomerId: string;
    suggestionType: "bio" | "protection_gap" | "contact_strategy";
    content: string;
    status: "awaiting_confirmation";
    runtimeFact: false;
  }>;
};

function cleanSegment(value: unknown, fallback: string): string {
  const cleaned = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return cleaned || fallback;
}

function stableSourceId(value: string | number): string {
  const result = String(value).trim();
  if (!result || result.length > 128)
    throw new Error("CUSTOMER_CRM_SOURCE_ID_INVALID");
  return result;
}

function globalCustomerId(source: InsuranceCustomerImportSourceV1): string {
  const tenant = cleanSegment(source.tenant_id, "DEFAULT");
  const sourceId = cleanSegment(stableSourceId(source.id), "UNKNOWN");
  return `DEMO-INS-${tenant}-${sourceId}`;
}

function isoDate(value: unknown, code: string): string {
  const text = String(value ?? "").trim();
  const timestamp = Date.parse(text);
  if (!text || !Number.isFinite(timestamp)) throw new Error(code);
  return new Date(timestamp).toISOString();
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function valueAtPath(root: JsonObject, rawPath: string): unknown {
  let value: unknown = root;
  for (const segment of rawPath.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = (value as JsonObject)[segment];
  }
  return value;
}

function absent(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function schemaFor(
  schemas: CustomerCrmDomainProfileSchemaSetV1,
  profileType: string
) {
  const schema = schemas.schemas.find(item => item.profileType === profileType);
  if (!schema || schema.status !== "active")
    throw new Error(
      `CUSTOMER_CRM_PROFILE_SCHEMA_REVIEW_REQUIRED:${profileType}`
    );
  return schema;
}

function validateDetail(input: {
  source: InsuranceCustomerImportSourceV1;
  schemas: CustomerCrmDomainProfileSchemaSetV1;
}) {
  const schema = schemaFor(input.schemas, input.source.profile_type);
  const root = { detail: object(input.source.detail) };
  const missing = schema.fields
    .filter(field => field.runtimeApproved)
    .filter(field => absent(valueAtPath(root, field.path)))
    .map(field => field.path);
  if (missing.length) {
    throw new Error(
      `CUSTOMER_CRM_PROFILE_FIELDS_MISSING:${input.source.id}:${missing.join(",")}`
    );
  }
  return schema;
}

function provenanceFor(
  source: InsuranceCustomerImportSourceV1,
  field: string,
  businessAsOf: string
) {
  const evidence = source.provenance?.[field];
  return {
    sourceSystem: String(evidence?.source || "insurance_customer_profile"),
    asOf: evidence?.updatedAt
      ? isoDate(evidence.updatedAt, "CUSTOMER_CRM_PROVENANCE_DATE_INVALID")
      : businessAsOf,
    sourceField: field,
  };
}

function sourceFingerprint(source: InsuranceCustomerImportSourceV1): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

export function prepareInsuranceCustomerCrmImport(input: {
  records: InsuranceCustomerImportSourceV1[];
  now?: Date;
  root?: string;
}): CustomerCrmImportBundleV1 {
  const generatedAt = (input.now || new Date()).toISOString();
  const { domainSchemas } = loadCustomerCrmContracts(
    input.root || process.cwd()
  );
  const seenSourceIds = new Set<string>();
  const seenGlobalIds = new Set<string>();
  const bundle: CustomerCrmImportBundleV1 = {
    schemaVersion: "ea.customer-crm-import-bundle.v1",
    generatedAt,
    sourceSystem: "insurance_customer_profile",
    customers: [],
    sourceLinks: [],
    domainProfiles: [],
    suggestions: [],
  };

  for (const source of input.records) {
    const sourceCustomerId = stableSourceId(source.id);
    if (seenSourceIds.has(sourceCustomerId))
      throw new Error(`CUSTOMER_CRM_SOURCE_ID_DUPLICATE:${sourceCustomerId}`);
    seenSourceIds.add(sourceCustomerId);
    const graceCustomerId = globalCustomerId(source);
    if (seenGlobalIds.has(graceCustomerId))
      throw new Error(`CUSTOMER_CRM_GLOBAL_ID_DUPLICATE:${graceCustomerId}`);
    seenGlobalIds.add(graceCustomerId);

    const displayName = String(source.name || "").trim();
    if (!displayName) throw new Error("CUSTOMER_CRM_DISPLAY_NAME_REQUIRED");
    const businessAsOf = isoDate(
      source.businessAsOf,
      `CUSTOMER_CRM_BUSINESS_AS_OF_INVALID:${sourceCustomerId}`
    );
    const schema = validateDetail({ source, schemas: domainSchemas });
    const fieldProvenance = Object.fromEntries(
      [
        "currentCoverageSummary",
        "claimsRiskSummary",
        "recentContactSummary",
        "confirmedNeeds",
        "budgetConcern",
        "servicePreference",
        "communicationPreference",
        ...schema.fields.map(field => field.path),
      ].map(field => [field, provenanceFor(source, field, businessAsOf)])
    );

    bundle.customers.push({
      graceCustomerId,
      displayName,
      customerStatus: String(source.customer_status || "unknown").slice(0, 500),
      tenantId: String(source.tenant_id || "default").slice(0, 128),
      ownerUserId: String(source.owner_user_id || "unassigned").slice(0, 128),
      businessAsOf,
    });
    bundle.sourceLinks.push({
      graceCustomerId,
      sourceSystem: "insurance_customer_profile",
      sourceCustomerId,
      sourceTenantId: String(source.tenant_id || "default").slice(0, 128),
      sourceRecordFingerprint: sourceFingerprint(source),
    });
    bundle.domainProfiles.push({
      graceCustomerId,
      profileType: source.profile_type,
      detailSchemaVersion: schema.detailSchemaVersion,
      demographics: {
        age: source.age,
        gender: source.gender,
        occupation: source.occupation,
        city: source.city,
      },
      preferences: {
        riskPreference: source.risk_preference,
        budgetConcern: source.budgetConcern,
        servicePreference: source.servicePreference,
        communicationPreference: source.communicationPreference,
      },
      insuranceFacts: {
        renewalAt: source.renewalAt,
        renewalStatus: source.renewalStatus,
        currentCoverageSummary: source.currentCoverageSummary,
        claimsRiskSummary: source.claimsRiskSummary,
        recentContactSummary: source.recentContactSummary,
        confirmedNeeds: source.confirmedNeeds,
      },
      detail: object(source.detail),
      fieldProvenance,
      runtimeStatus: "candidate",
    });
    for (const suggestion of [
      ["bio", source.bio],
      ["protection_gap", source.protection_gap],
      ["contact_strategy", source.contact_strategy],
    ] as const) {
      const content = String(suggestion[1] || "").trim();
      if (!content) continue;
      bundle.suggestions.push({
        graceCustomerId,
        suggestionType: suggestion[0],
        content,
        status: "awaiting_confirmation",
        runtimeFact: false,
      });
    }
  }

  return bundle;
}

function csvCell(value: unknown): string {
  const text =
    value && typeof value === "object"
      ? JSON.stringify(value)
      : String(value ?? "");
  return `"${text.replace(/"/gu, '""')}"`;
}

export function recordsToCsv(records: JsonObject[]): string {
  const headers = Array.from(
    new Set(records.flatMap(record => Object.keys(record)))
  );
  return [
    headers.map(csvCell).join(","),
    ...records.map(record =>
      headers.map(key => csvCell(record[key])).join(",")
    ),
  ].join("\n");
}
