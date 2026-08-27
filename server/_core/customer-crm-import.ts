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

export type WealthCustomerMcpExportV1 = {
  schemaVersion: "ea.wealth-customer-mcp-export.v1";
  exportedAt: string;
  source: string;
  records: Array<{
    directory: JsonObject;
    detail: JsonObject;
  }>;
};

export type CustomerCrmIdentityCrosswalkEntryV1 = {
  sourceSystem: string;
  sourceTenantId: string;
  sourceCustomerId: string;
  globalCustomerId: string;
};

export type CustomerCrmIdentityCrosswalkV1 = {
  schemaVersion: "ea.customer-crm-identity-crosswalk.v1";
  crosswalkVersion: string;
  mappings: CustomerCrmIdentityCrosswalkEntryV1[];
};

export type CustomerCrmImportBundleV1 = {
  schemaVersion: "ea.customer-crm-import-bundle.v1";
  generatedAt: string;
  sourceSystem: string;
  customers: Array<{
    globalCustomerId: string;
    displayName: string;
    customerStatus: string;
    visibilityScope: "demo_public" | "restricted";
    tenantId: string;
    ownerUserId: string;
    businessAsOf: string;
    maskedPhone?: string;
  }>;
  assignments: Array<{
    assignmentKey: string;
    globalCustomerId: string;
    organizationId: string;
    principalType: "user" | "team" | "role_adoption";
    principalRef: string;
    businessDomain?: string;
    relationshipRole?: "primary" | "support";
    assignmentStatus: "active" | "inactive";
    validFrom?: string;
    validTo?: string;
  }>;
  sourceLinks: Array<{
    globalCustomerId: string;
    sourceSystem: string;
    sourceCustomerId: string;
    sourceTenantId: string;
    sourceRecordFingerprint: string;
  }>;
  domainProfiles: Array<{
    globalCustomerId: string;
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
    globalCustomerId: string;
    suggestionType: "bio" | "protection_gap" | "contact_strategy";
    content: string;
    status: "awaiting_confirmation";
    runtimeFact: false;
  }>;
};

export type NativeCustomerCrmFixtureSetV1 = {
  schemaVersion: "ea.native-customer-crm-fixtures.v1";
  customers: Array<{
    globalCustomerId: string;
    displayName: string;
    customerStatus: "active" | "inactive";
    visibilityScope: "demo_public" | "restricted";
    tenantId: string;
    ownerUserId: string;
    businessAsOf: string;
    maskedPhone?: string;
    profiles: Array<{
      profileType: string;
      demographics: JsonObject;
      preferences: JsonObject;
      insuranceFacts: JsonObject;
      detail: JsonObject;
    }>;
  }>;
  assignments: CustomerCrmImportBundleV1["assignments"];
};

function stableSourceId(value: string | number): string {
  const result = String(value).trim();
  if (!result || result.length > 128)
    throw new Error("CUSTOMER_CRM_SOURCE_ID_INVALID");
  return result;
}

function crosswalkCustomerId(input: {
  crosswalk: CustomerCrmIdentityCrosswalkV1;
  sourceSystem: string;
  sourceTenantId: string;
  sourceCustomerId: string;
}): string {
  const matches = input.crosswalk.mappings.filter(
    item =>
      item.sourceSystem === input.sourceSystem &&
      item.sourceTenantId === input.sourceTenantId &&
      item.sourceCustomerId === input.sourceCustomerId
  );
  if (matches.length !== 1)
    throw new Error(
      `CUSTOMER_CRM_IDENTITY_CROSSWALK_${matches.length ? "AMBIGUOUS" : "REQUIRED"}:${input.sourceSystem}:${input.sourceTenantId}:${input.sourceCustomerId}`
    );
  const globalCustomerId = matches[0]!.globalCustomerId.trim();
  if (!/^CUST-[0-9]{6}$/u.test(globalCustomerId))
    throw new Error("CUSTOMER_CRM_GLOBAL_ID_INVALID");
  return globalCustomerId;
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

function validateProfileDetail(input: {
  profileType: string;
  detail: JsonObject;
  sourceId: string;
  schemas: CustomerCrmDomainProfileSchemaSetV1;
}) {
  const schema = schemaFor(input.schemas, input.profileType);
  const root = { detail: input.detail };
  const missing = schema.fields
    .filter(field => field.runtimeApproved)
    .filter(field => absent(valueAtPath(root, field.path)))
    .map(field => field.path);
  if (missing.length) {
    throw new Error(
      `CUSTOMER_CRM_PROFILE_FIELDS_MISSING:${input.sourceId}:${missing.join(",")}`
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

function sourceFingerprint(source: unknown): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

export function prepareInsuranceCustomerCrmImport(input: {
  records: InsuranceCustomerImportSourceV1[];
  crosswalk: CustomerCrmIdentityCrosswalkV1;
  canonicalTenantId?: string;
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
    assignments: [],
    sourceLinks: [],
    domainProfiles: [],
    suggestions: [],
  };

  for (const source of input.records) {
    const sourceCustomerId = stableSourceId(source.id);
    if (seenSourceIds.has(sourceCustomerId))
      throw new Error(`CUSTOMER_CRM_SOURCE_ID_DUPLICATE:${sourceCustomerId}`);
    seenSourceIds.add(sourceCustomerId);
    const sourceTenantId = String(source.tenant_id || "default").slice(0, 128);
    const globalCustomerId = crosswalkCustomerId({
      crosswalk: input.crosswalk,
      sourceSystem: "insurance_customer_profile",
      sourceTenantId,
      sourceCustomerId,
    });
    if (seenGlobalIds.has(globalCustomerId))
      throw new Error(`CUSTOMER_CRM_GLOBAL_ID_DUPLICATE:${globalCustomerId}`);
    seenGlobalIds.add(globalCustomerId);

    const displayName = String(source.name || "").trim();
    if (!displayName) throw new Error("CUSTOMER_CRM_DISPLAY_NAME_REQUIRED");
    const businessAsOf = isoDate(
      source.businessAsOf,
      `CUSTOMER_CRM_BUSINESS_AS_OF_INVALID:${sourceCustomerId}`
    );
    const detail = object(source.detail);
    const schema = validateProfileDetail({
      profileType: source.profile_type,
      detail,
      sourceId: sourceCustomerId,
      schemas: domainSchemas,
    });
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
      globalCustomerId,
      displayName,
      customerStatus: "active",
      visibilityScope: "demo_public",
      tenantId: String(input.canonicalTenantId || sourceTenantId).slice(0, 128),
      ownerUserId: String(source.owner_user_id || "unassigned").slice(0, 128),
      businessAsOf,
    });
    bundle.sourceLinks.push({
      globalCustomerId,
      sourceSystem: "insurance_customer_profile",
      sourceCustomerId,
      sourceTenantId,
      sourceRecordFingerprint: sourceFingerprint(source),
    });
    bundle.domainProfiles.push({
      globalCustomerId,
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
      detail,
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
        globalCustomerId,
        suggestionType: suggestion[0],
        content,
        status: "awaiting_confirmation",
        runtimeFact: false,
      });
    }
  }

  return bundle;
}

function wealthCustomerRecord(
  record: WealthCustomerMcpExportV1["records"][number]
) {
  const directory = object(record.directory);
  const detail = object(record.detail);
  const customer = object(detail.customer);
  const assetInfo = object(detail.assetInfo);
  const sourceCustomerId = stableSourceId(
    String(
      customer.customerId ||
        customer.id ||
        directory.customerId ||
        directory.id ||
        ""
    )
  );
  const displayName = String(
    customer.name || directory.customerName || directory.name || ""
  ).trim();
  if (!displayName) throw new Error("CUSTOMER_CRM_DISPLAY_NAME_REQUIRED");
  return { detail, customer, assetInfo, sourceCustomerId, displayName };
}

export function prepareWealthCustomerCrmImport(input: {
  export: WealthCustomerMcpExportV1;
  crosswalk: CustomerCrmIdentityCrosswalkV1;
  sourceTenantId: string;
  canonicalTenantId: string;
  ownerUserId: string;
  now?: Date;
  root?: string;
}): CustomerCrmImportBundleV1 {
  if (input.export.schemaVersion !== "ea.wealth-customer-mcp-export.v1")
    throw new Error("CUSTOMER_CRM_WEALTH_EXPORT_UNSUPPORTED");
  const generatedAt = (input.now || new Date()).toISOString();
  const { domainSchemas } = loadCustomerCrmContracts(
    input.root || process.cwd()
  );
  const bundle: CustomerCrmImportBundleV1 = {
    schemaVersion: "ea.customer-crm-import-bundle.v1",
    generatedAt,
    sourceSystem: "wealth_assistant_customer",
    customers: [],
    assignments: [],
    sourceLinks: [],
    domainProfiles: [],
    suggestions: [],
  };
  const seen = new Set<string>();
  for (const rawRecord of input.export.records) {
    const record = wealthCustomerRecord(rawRecord);
    if (seen.has(record.sourceCustomerId))
      throw new Error(
        `CUSTOMER_CRM_SOURCE_ID_DUPLICATE:${record.sourceCustomerId}`
      );
    seen.add(record.sourceCustomerId);
    const globalCustomerId = crosswalkCustomerId({
      crosswalk: input.crosswalk,
      sourceSystem: "wealth_assistant_customer",
      sourceTenantId: input.sourceTenantId,
      sourceCustomerId: record.sourceCustomerId,
    });
    const businessAsOf = isoDate(
      record.customer.dataAsOf || input.export.exportedAt,
      `CUSTOMER_CRM_BUSINESS_AS_OF_INVALID:${record.sourceCustomerId}`
    );
    const profileDetail = {
      customerTier: record.customer.customerTier,
      riskAssessment: {
        riskLevel: record.customer.riskLevel,
        riskPreference: record.customer.riskPreference,
        validUntil: record.customer.assessmentExpiresAt,
      },
      assetAllocationSummary: {
        aumBand: record.customer.aumBand,
        totalAssets: record.assetInfo.totalAssets,
      },
      portfolioSummary: record.assetInfo,
      holdings: Array.isArray(record.detail.heldProducts)
        ? record.detail.heldProducts
        : [],
      maturities: Array.isArray(record.detail.maturedProducts)
        ? record.detail.maturedProducts
        : [],
    };
    const schema = validateProfileDetail({
      profileType: "wealth",
      detail: profileDetail,
      sourceId: record.sourceCustomerId,
      schemas: domainSchemas,
    });
    const provenanceFields = [
      "maskedPhone",
      "demographics.ageBand",
      "demographics.occupationCategory",
      "preferences.riskPreference",
      ...schema.fields.map(field => field.path),
    ];
    const fieldProvenance = Object.fromEntries(
      provenanceFields.map(field => [
        field,
        {
          sourceSystem: "wealth_assistant_customer",
          asOf: businessAsOf,
          sourceField: field,
        },
      ])
    );
    bundle.customers.push({
      globalCustomerId,
      displayName: record.displayName,
      customerStatus:
        String(record.customer.customerStatus || "active") === "inactive"
          ? "inactive"
          : "active",
      visibilityScope: "demo_public",
      tenantId: input.canonicalTenantId,
      ownerUserId: input.ownerUserId,
      businessAsOf,
      maskedPhone:
        String(record.customer.maskedPhone || "").trim() || undefined,
    });
    bundle.sourceLinks.push({
      globalCustomerId,
      sourceSystem: "wealth_assistant_customer",
      sourceCustomerId: record.sourceCustomerId,
      sourceTenantId: input.sourceTenantId,
      sourceRecordFingerprint: sourceFingerprint(rawRecord),
    });
    bundle.domainProfiles.push({
      globalCustomerId,
      profileType: "wealth",
      detailSchemaVersion: schema.detailSchemaVersion,
      demographics: {
        ageBand: record.customer.ageBand,
        occupationCategory: record.customer.occupationCategory,
      },
      preferences: {
        riskPreference: record.customer.riskPreference,
      },
      insuranceFacts: {},
      detail: profileDetail,
      fieldProvenance,
      runtimeStatus: "candidate",
    });
  }
  return bundle;
}

export function prepareNativeCustomerCrmFixtures(input: {
  fixtures: NativeCustomerCrmFixtureSetV1;
  now?: Date;
  root?: string;
}): CustomerCrmImportBundleV1 {
  if (input.fixtures.schemaVersion !== "ea.native-customer-crm-fixtures.v1")
    throw new Error("CUSTOMER_CRM_NATIVE_FIXTURE_SCHEMA_UNSUPPORTED");
  const generatedAt = (input.now || new Date()).toISOString();
  const { domainSchemas } = loadCustomerCrmContracts(
    input.root || process.cwd()
  );
  const bundle: CustomerCrmImportBundleV1 = {
    schemaVersion: "ea.customer-crm-import-bundle.v1",
    generatedAt,
    sourceSystem: "twenty_crm",
    customers: [],
    assignments: [],
    sourceLinks: [],
    domainProfiles: [],
    suggestions: [],
  };
  const customerIds = new Set<string>();
  const profileKeys = new Set<string>();
  for (const customer of input.fixtures.customers) {
    const globalCustomerId = customer.globalCustomerId.trim();
    if (!/^CUST-[0-9]{6}$/u.test(globalCustomerId))
      throw new Error("CUSTOMER_CRM_GLOBAL_ID_INVALID");
    if (customerIds.has(globalCustomerId))
      throw new Error(`CUSTOMER_CRM_GLOBAL_ID_DUPLICATE:${globalCustomerId}`);
    customerIds.add(globalCustomerId);
    const businessAsOf = isoDate(
      customer.businessAsOf,
      `CUSTOMER_CRM_BUSINESS_AS_OF_INVALID:${globalCustomerId}`
    );
    bundle.customers.push({
      globalCustomerId,
      displayName: customer.displayName.trim(),
      customerStatus: customer.customerStatus,
      visibilityScope: customer.visibilityScope,
      tenantId: customer.tenantId.trim(),
      ownerUserId: customer.ownerUserId.trim(),
      businessAsOf,
      maskedPhone: customer.maskedPhone?.trim() || undefined,
    });
    for (const profile of customer.profiles) {
      const key = `${globalCustomerId}:${profile.profileType}`;
      if (profileKeys.has(key))
        throw new Error(`CUSTOMER_CRM_PROFILE_DUPLICATE:${key}`);
      profileKeys.add(key);
      const schema = validateProfileDetail({
        profileType: profile.profileType,
        detail: profile.detail,
        sourceId: globalCustomerId,
        schemas: domainSchemas,
      });
      const provenanceFields = [
        ...Object.keys(profile.demographics).map(
          field => `demographics.${field}`
        ),
        ...Object.keys(profile.preferences).map(
          field => `preferences.${field}`
        ),
        ...Object.keys(profile.insuranceFacts),
        ...schema.fields.map(field => field.path),
      ];
      bundle.domainProfiles.push({
        globalCustomerId,
        profileType: profile.profileType,
        detailSchemaVersion: schema.detailSchemaVersion,
        demographics: profile.demographics,
        preferences: profile.preferences,
        insuranceFacts: profile.insuranceFacts,
        detail: profile.detail,
        fieldProvenance: Object.fromEntries(
          provenanceFields.map(field => [
            field,
            {
              sourceSystem: "twenty_crm",
              asOf: businessAsOf,
              sourceField: field,
            },
          ])
        ),
        runtimeStatus: "candidate",
      });
    }
  }
  for (const assignment of input.fixtures.assignments) {
    if (!customerIds.has(assignment.globalCustomerId))
      throw new Error(
        `CUSTOMER_CRM_ASSIGNMENT_CUSTOMER_NOT_FOUND:${assignment.assignmentKey}`
      );
    bundle.assignments.push(assignment);
  }
  return bundle;
}

export function mergeCustomerCrmImportBundles(
  bundles: CustomerCrmImportBundleV1[],
  now = new Date()
): CustomerCrmImportBundleV1 {
  const merged: CustomerCrmImportBundleV1 = {
    schemaVersion: "ea.customer-crm-import-bundle.v1",
    generatedAt: now.toISOString(),
    sourceSystem: "customer_source_composition",
    customers: [],
    assignments: [],
    sourceLinks: [],
    domainProfiles: [],
    suggestions: [],
  };
  const customers = new Map<
    string,
    CustomerCrmImportBundleV1["customers"][number]
  >();
  const sourceLinks = new Set<string>();
  const assignments = new Set<string>();
  const profiles = new Set<string>();
  const suggestions = new Set<string>();
  for (const bundle of bundles) {
    for (const customer of bundle.customers) {
      const existing = customers.get(customer.globalCustomerId);
      if (
        existing &&
        (existing.displayName !== customer.displayName ||
          existing.tenantId !== customer.tenantId)
      )
        throw new Error(
          `CUSTOMER_CRM_IDENTITY_CONFLICT:${customer.globalCustomerId}`
        );
      if (!existing) customers.set(customer.globalCustomerId, customer);
    }
    for (const assignment of bundle.assignments) {
      if (assignments.has(assignment.assignmentKey))
        throw new Error(
          `CUSTOMER_CRM_ASSIGNMENT_DUPLICATE:${assignment.assignmentKey}`
        );
      assignments.add(assignment.assignmentKey);
      merged.assignments.push(assignment);
    }
    for (const link of bundle.sourceLinks) {
      const key = `${link.sourceSystem}:${link.sourceTenantId}:${link.sourceCustomerId}`;
      if (sourceLinks.has(key))
        throw new Error(`CUSTOMER_CRM_SOURCE_LINK_DUPLICATE:${key}`);
      sourceLinks.add(key);
      merged.sourceLinks.push(link);
    }
    for (const profile of bundle.domainProfiles) {
      const key = `${profile.globalCustomerId}:${profile.profileType}`;
      if (profiles.has(key))
        throw new Error(`CUSTOMER_CRM_PROFILE_DUPLICATE:${key}`);
      profiles.add(key);
      merged.domainProfiles.push(profile);
    }
    for (const suggestion of bundle.suggestions) {
      const key = `${suggestion.globalCustomerId}:${suggestion.suggestionType}`;
      if (suggestions.has(key))
        throw new Error(`CUSTOMER_CRM_SUGGESTION_DUPLICATE:${key}`);
      suggestions.add(key);
      merged.suggestions.push(suggestion);
    }
  }
  merged.customers = Array.from(customers.values());
  return merged;
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
