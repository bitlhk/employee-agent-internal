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
const expectedRuntimeStatus = argument("--runtime-status") || "candidate";
if (!["candidate", "active"].includes(expectedRuntimeStatus))
  throw new Error("--runtime-status must be candidate or active");
const bundle = JSON.parse(
  readFileSync(path.resolve(bundlePath), "utf8")
) as CustomerCrmImportBundleV1;
const client = new TwentyCustomerCrmClientV1({
  baseUrl: String(process.env.TWENTY_BASE_URL || ""),
  apiKey: String(process.env.TWENTY_API_KEY || ""),
});

const selectedProfileTypes = [
  "wealth",
  "auto_insurance",
  "life_insurance",
] as const;
const selected = selectedProfileTypes
  .map(profileType =>
    bundle.domainProfiles.find(item => item.profileType === profileType)
  )
  .filter((item): item is CustomerCrmImportBundleV1["domainProfiles"][number] =>
    Boolean(item)
  );
if (selected.length !== selectedProfileTypes.length)
  throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_FIXTURES_MISSING");

const observations = [];
for (const expected of selected) {
  const customer = bundle.customers.find(
    item => item.globalCustomerId === expected.globalCustomerId
  );
  if (!customer)
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_CUSTOMER_MISSING");
  const roleTemplate =
    expected.profileType === "wealth"
      ? ("wealth-manager" as const)
      : ("insurance-advisor" as const);
  const principal: RuntimePrincipalV2 = {
    userId: Number(customer.ownerUserId) || 1,
    adoptionId: `${roleTemplate}-shadow`,
    agentId: `${roleTemplate}-shadow`,
    roleTemplate,
    workspaceId: "customer-crm-shadow",
    permissionProfile: roleTemplate,
    sessionId: "customer-crm-environment-verification",
    tenantId: customer.tenantId,
    organizationId: "org_linggan_finance",
    authorizationSnapshotId: "customer-crm-shadow-v1",
    authorizationFingerprint: createHash("sha256")
      .update(`${customer.tenantId}:${expected.profileType}:shadow-v1`)
      .digest("hex"),
    identityVersion: "2",
  };
  const recordLoader = createTwentyCustomerProfileRecordLoaderV1({
    client,
    allowedRuntimeStatuses: [expectedRuntimeStatus as "candidate" | "active"],
    authorize: request => ({
      allowed:
        request.principal.tenantId === customer.tenantId &&
        request.principal.organizationId === "org_linggan_finance",
      subjectInScope: request.globalCustomerId === expected.globalCustomerId,
      authorizationEvidenceId: `customer-crm-shadow:${expected.profileType}`,
      allowedProfileTypes: [expected.profileType],
    }),
  });
  const loaded = await loadTwentyCustomerProfileCompatibilitySource({
    principal,
    subjectId: expected.globalCustomerId,
    recordLoader,
    productionReady: expectedRuntimeStatus === "active",
  });
  const source = loaded.sources[0];
  if (!source)
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_PROFILE_MISMATCH");
  const actual = await client.loadCustomerProfile({
    globalCustomerId: expected.globalCustomerId,
    allowedProfileTypes: [expected.profileType],
    allowedRuntimeStatuses: [expectedRuntimeStatus as "candidate" | "active"],
  });
  const actualProfile = actual?.profiles.find(
    profile => profile.profileType === expected.profileType
  );
  if (
    !actualProfile ||
    actualProfile.detailSchemaVersion !== expected.detailSchemaVersion
  )
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_SCHEMA_MISMATCH");
  if (
    source.productionReady !== (expectedRuntimeStatus === "active") ||
    source.assuranceLevel !==
      (expectedRuntimeStatus === "active" ? "production" : "candidate")
  )
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_ASSURANCE_MISMATCH");
  const serializedSource = JSON.stringify(source);
  if (
    serializedSource.includes("purchasePrice") ||
    serializedSource.includes("totalAssets") ||
    serializedSource.includes("contact_strategy") ||
    serializedSource.includes("protection_gap")
  )
    throw new Error("TWENTY_CUSTOMER_CRM_ENVIRONMENT_FIELD_LEAKAGE");
  const otherProfileType = selectedProfileTypes.find(
    profileType => profileType !== expected.profileType
  )!;
  await client
    .loadCustomerProfile({
      globalCustomerId: expected.globalCustomerId,
      allowedProfileTypes: [otherProfileType],
      allowedRuntimeStatuses: [expectedRuntimeStatus as "candidate" | "active"],
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
      .update(actual.globalCustomerId)
      .digest("hex"),
    profileType: actualProfile.profileType,
    roleTemplate,
    detailSchemaVersion: actualProfile.detailSchemaVersion,
    runtimeStatus: actualProfile.runtimeStatus,
    provenanceFieldCount: Object.keys(actualProfile.fieldProvenance).length,
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
      productionActivated: expectedRuntimeStatus === "active",
      runtimeProjections:
        expectedRuntimeStatus === "active"
          ? ["wealth-manager-production", "insurance-advisor-production"]
          : ["wealth-manager-shadow", "insurance-advisor-shadow"],
      observations,
    },
    null,
    2
  )
);
