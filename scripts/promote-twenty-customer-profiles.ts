import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CustomerCrmImportBundleV1 } from "../server/_core/customer-crm-import";

type JsonObject = Record<string, unknown>;

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function requiredEnvironment(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function fetchWithRateLimitRetry(
  request: () => Promise<Response>
): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request();
    if (response.status !== 429) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter)
      ? Math.max(1_000, retryAfter * 1_000)
      : 5_000 * (attempt + 1);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error("TWENTY_CUSTOMER_PROFILE_PROMOTION_RATE_LIMITED");
}

async function batchUpsert(
  baseUrl: string,
  apiKey: string,
  records: JsonObject[]
) {
  for (let index = 0; index < records.length; index += 60) {
    const request = () =>
      fetch(`${baseUrl}/rest/batch/customerDomainProfiles?upsert=true`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(records.slice(index, index + 60)),
        signal: AbortSignal.timeout(20_000),
      });
    const response = await fetchWithRateLimitRetry(request);
    if (!response.ok)
      throw new Error(
        `TWENTY_CUSTOMER_PROFILE_PROMOTION_WRITE_FAILED:${response.status}`
      );
  }
}

async function loadCurrentProfiles(baseUrl: string, apiKey: string) {
  const request = () =>
    fetch(`${baseUrl}/rest/customerDomainProfiles?limit=1000`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  const response = await fetchWithRateLimitRetry(request);
  if (!response.ok)
    throw new Error(
      `TWENTY_CUSTOMER_PROFILE_PROMOTION_READ_FAILED:${response.status}`
    );
  const body = (await response.json()) as {
    data?: { customerDomainProfiles?: JsonObject[] };
  };
  return Array.isArray(body.data?.customerDomainProfiles)
    ? body.data.customerDomainProfiles
    : [];
}

const bundlePath = argument("--bundle");
const apply = process.argv.includes("--apply");
if (!bundlePath) throw new Error("Usage requires --bundle <path> [--apply]");
const rawBundle = readFileSync(path.resolve(bundlePath), "utf8");
const bundle = JSON.parse(rawBundle) as CustomerCrmImportBundleV1;
if (bundle.schemaVersion !== "ea.customer-crm-import-bundle.v1")
  throw new Error("TWENTY_CUSTOMER_PROFILE_PROMOTION_BUNDLE_UNSUPPORTED");
const baseUrl = requiredEnvironment("TWENTY_BASE_URL").replace(/\/$/u, "");
const apiKey = requiredEnvironment("TWENTY_API_KEY");
const currentProfiles = await loadCurrentProfiles(baseUrl, apiKey);

for (const expected of bundle.domainProfiles) {
  const profile = currentProfiles.find(
    item =>
      String(item.globalCustomerId || "") === expected.globalCustomerId &&
      String(item.profileType || "") === expected.profileType
  );
  if (!profile)
    throw new Error(
      `TWENTY_CUSTOMER_PROFILE_PROMOTION_PROFILE_MISSING:${expected.globalCustomerId}:${expected.profileType}`
    );
  if (
    String(profile.detailSchemaVersion || "") !== expected.detailSchemaVersion
  )
    throw new Error(
      `TWENTY_CUSTOMER_PROFILE_PROMOTION_SCHEMA_MISMATCH:${expected.globalCustomerId}:${expected.profileType}`
    );
}

if (apply) {
  await batchUpsert(
    baseUrl,
    apiKey,
    bundle.domainProfiles.map(record => ({
      name: `${record.globalCustomerId}:${record.profileType}`,
      profileKey: `${record.globalCustomerId}:${record.profileType}`,
      ...record,
      runtimeStatus: "active",
    }))
  );
}

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      schemaVersion: "ea.twenty-customer-profile-promotion.v1",
      status: apply ? "PROMOTED" : "READY_TO_PROMOTE",
      bundleFingerprint: createHash("sha256").update(rawBundle).digest("hex"),
      profileCount: bundle.domainProfiles.length,
      promotedAt: apply ? new Date().toISOString() : null,
    },
    null,
    2
  )
);
