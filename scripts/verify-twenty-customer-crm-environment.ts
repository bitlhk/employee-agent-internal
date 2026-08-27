import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CustomerCrmImportBundleV1 } from "../server/_core/customer-crm-import";
import type { RuntimePrincipalV2 } from "../server/_core/governance/contracts";
import { loadTwentyCustomerProfileCompatibilitySource } from "../server/_core/customer-profile-twenty-adapter";
import {
  createTwentyCustomerProfileRecordLoaderV1,
  TwentyCustomerCrmClientV1,
} from "../server/_core/customer-profile-twenty-client";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const bundlePath = argument("--bundle");
if (!bundlePath) throw new Error("Usage requires --bundle <path>");
const bundle = JSON.parse(
  readFileSync(path.resolve(bundlePath), "utf8")
) as CustomerCrmImportBundleV1;
const client = new TwentyCustomerCrmClientV1({
  baseUrl: String(process.env.TWENTY_BASE_URL || ""),
  apiKey: String(process.env.TWENTY_API_KEY || ""),
});

const selected = [
  bundle.domainProfiles.find(item => item.profileType === "auto_insurance"),
  bundle.domainProfiles.find(item => item.profileType === "life_insurance"),
].filter((item): item is CustomerCrmImportBundleV1["domainProfiles"][number] =>
  Boolean(item)
);
if (selected.length !== 2)
  throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_FIXTURES_MISSING");

const observations = [];
for (const expected of selected) {
  const customer = bundle.customers.find(
    item => item.graceCustomerId === expected.graceCustomerId
  );
  if (!customer)
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_CUSTOMER_MISSING");
  const principal: RuntimePrincipalV2 = {
    userId: Number(customer.ownerUserId) || 1,
    adoptionId: "insurance-advisor-shadow",
    agentId: "insurance-advisor-shadow",
    roleTemplate: "insurance-advisor",
    workspaceId: "customer-crm-shadow",
    permissionProfile: "insurance-advisor",
    sessionId: "customer-crm-environment-verification",
    tenantId: customer.tenantId,
    organizationId: customer.tenantId,
    authorizationSnapshotId: "customer-crm-shadow-v1",
    authorizationFingerprint: createHash("sha256")
      .update(`${customer.tenantId}:${expected.profileType}:shadow-v1`)
      .digest("hex"),
    identityVersion: "2",
  };
  const recordLoader = createTwentyCustomerProfileRecordLoaderV1({
    client,
    authorize: request => ({
      allowed: request.principal.organizationId === customer.tenantId,
      subjectInScope: request.graceCustomerId === expected.graceCustomerId,
      authorizationEvidenceId: `customer-crm-shadow:${expected.profileType}`,
      allowedProfileTypes: [expected.profileType],
    }),
  });
  const loaded = await loadTwentyCustomerProfileCompatibilitySource({
    principal,
    subjectId: expected.graceCustomerId,
    recordLoader,
  });
  const source = loaded.sources[0];
  if (!source)
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_PROFILE_MISMATCH");
  const actual = await client.loadCustomerProfile({
    graceCustomerId: expected.graceCustomerId,
    allowedProfileTypes: [expected.profileType],
  });
  if (!actual || actual.detailSchemaVersion !== expected.detailSchemaVersion)
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_SCHEMA_MISMATCH");
  if (source.productionReady || source.assuranceLevel !== "candidate")
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_SHADOW_BOUNDARY_BROKEN");
  const serializedSource = JSON.stringify(source);
  if (
    serializedSource.includes("purchasePrice") ||
    serializedSource.includes("contact_strategy") ||
    serializedSource.includes("protection_gap")
  )
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_FIELD_LEAKAGE");
  const otherProfileType =
    expected.profileType === "auto_insurance"
      ? "life_insurance"
      : "auto_insurance";
  await client
    .loadCustomerProfile({
      graceCustomerId: expected.graceCustomerId,
      allowedProfileTypes: [otherProfileType],
    })
    .then(() => {
      throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_CROSS_PROFILE_LEAKAGE");
    })
    .catch(error => {
      if (
        !(error instanceof Error) ||
        error.message !== "TWENTY_CUSTOMER_CRM_PROFILE_NOT_ELIGIBLE"
      )
        throw error;
    });
  observations.push({
    subjectFingerprint: createHash("sha256")
      .update(actual.graceCustomerId)
      .digest("hex"),
    profileType: actual.profileType,
    detailSchemaVersion: actual.detailSchemaVersion,
    provenanceFieldCount: Object.keys(actual.fieldProvenance).length,
    providedFieldCount: source.fields.length,
    sourceFingerprint: source.resultFingerprint,
    crossProfileLeakage: 0,
  });
}

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      schemaVersion: "ea.twenty-customer-crm-environment-verification.v1",
      status: "PASS",
      productionActivated: false,
      runtimeProjection: "insurance-advisor-shadow",
      observations,
    },
    null,
    2
  )
);
