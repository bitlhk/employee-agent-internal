import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  prepareInsuranceCustomerCrmImport,
  recordsToCsv,
  type InsuranceCustomerImportSourceV1,
} from "../server/_core/customer-crm-import";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const inputPath = argument("--input");
const outputDir = argument("--output-dir");
if (!inputPath || !outputDir) {
  throw new Error(
    "Usage: pnpm customer-crm:prepare-demo --input <data.json> --output-dir <dir>"
  );
}

const records = JSON.parse(
  readFileSync(path.resolve(inputPath), "utf8")
) as InsuranceCustomerImportSourceV1[];
if (!Array.isArray(records))
  throw new Error("CRM import input must be an array");

const bundle = prepareInsuranceCustomerCrmImport({ records });
mkdirSync(path.resolve(outputDir), { recursive: true });
const outputs: Array<[string, unknown]> = [
  ["customer-crm-import-bundle.v1.json", bundle],
  ["customers.csv", recordsToCsv(bundle.customers)],
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
      sourceLinks: bundle.sourceLinks.length,
      domainProfiles: bundle.domainProfiles.length,
      suggestions: bundle.suggestions.length,
      outputDir: path.resolve(outputDir),
    },
    null,
    2
  )
);
