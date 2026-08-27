import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  mergeCustomerCrmImportBundles,
  prepareNativeCustomerCrmFixtures,
  prepareInsuranceCustomerCrmImport,
  prepareWealthCustomerCrmImport,
  recordsToCsv,
  type CustomerCrmIdentityCrosswalkV1,
  type InsuranceCustomerImportSourceV1,
  type NativeCustomerCrmFixtureSetV1,
  type WealthCustomerMcpExportV1,
} from "../server/_core/customer-crm-import";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const insuranceInputPath = argument("--insurance-input") || argument("--input");
const wealthInputPath = argument("--wealth-input");
const nativeInputPath = argument("--native-input");
const crosswalkPath =
  argument("--crosswalk") ||
  "examples/customer-crm-v1/customer-demo-identity-crosswalk.v1.json";
const outputDir = argument("--output-dir");
if (
  (!insuranceInputPath && !wealthInputPath && !nativeInputPath) ||
  !outputDir
) {
  throw new Error(
    "Usage: pnpm customer-crm:prepare-demo [--insurance-input <data.json>] [--wealth-input <wealth-export.json>] [--native-input <fixtures.json>] --output-dir <dir>"
  );
}

const crosswalk = JSON.parse(
  readFileSync(path.resolve(crosswalkPath), "utf8")
) as CustomerCrmIdentityCrosswalkV1;
if (crosswalk.schemaVersion !== "ea.customer-crm-identity-crosswalk.v1")
  throw new Error("CRM identity crosswalk schema is unsupported");

const bundles = [];
if (insuranceInputPath) {
  const records = JSON.parse(
    readFileSync(path.resolve(insuranceInputPath), "utf8")
  ) as InsuranceCustomerImportSourceV1[];
  if (!Array.isArray(records))
    throw new Error("Insurance CRM import input must be an array");
  bundles.push(
    prepareInsuranceCustomerCrmImport({
      records,
      crosswalk,
      canonicalTenantId: argument("--tenant-id") || "tn_linggan_finance",
    })
  );
}
if (wealthInputPath) {
  const wealthExport = JSON.parse(
    readFileSync(path.resolve(wealthInputPath), "utf8")
  ) as WealthCustomerMcpExportV1;
  bundles.push(
    prepareWealthCustomerCrmImport({
      export: wealthExport,
      crosswalk,
      sourceTenantId:
        argument("--wealth-source-tenant-id") || "tn_linggan_finance",
      canonicalTenantId: argument("--tenant-id") || "tn_linggan_finance",
      ownerUserId: argument("--wealth-owner-user-id") || "2",
    })
  );
}
if (nativeInputPath) {
  const fixtures = JSON.parse(
    readFileSync(path.resolve(nativeInputPath), "utf8")
  ) as NativeCustomerCrmFixtureSetV1;
  bundles.push(prepareNativeCustomerCrmFixtures({ fixtures }));
}

const bundle = mergeCustomerCrmImportBundles(bundles);
mkdirSync(path.resolve(outputDir), { recursive: true });
const outputs: Array<[string, unknown]> = [
  ["customer-crm-import-bundle.v1.json", bundle],
  ["customers.csv", recordsToCsv(bundle.customers)],
  ["customer-assignments.csv", recordsToCsv(bundle.assignments)],
  ["customer-source-links.csv", recordsToCsv(bundle.sourceLinks)],
  ["customer-domain-profiles.csv", recordsToCsv(bundle.domainProfiles)],
  ["customer-suggestions.csv", recordsToCsv(bundle.suggestions)],
];
for (const [name, value] of outputs) {
  const target = path.resolve(outputDir, name);
  writeFileSync(
    target,
    typeof value === "string"
      ? `${value}\n`
      : `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      schema: bundle.schemaVersion,
      customers: bundle.customers.length,
      assignments: bundle.assignments.length,
      sourceLinks: bundle.sourceLinks.length,
      domainProfiles: bundle.domainProfiles.length,
      suggestions: bundle.suggestions.length,
      outputDir: path.resolve(outputDir),
    },
    null,
    2
  )
);
