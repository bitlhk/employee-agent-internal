import { createHash } from "node:crypto";
import type {
  CustomerProfileFieldProvenanceV1,
  CustomerProfileSourceContractV1,
} from "../../shared/customer-profile-contract";
import { loadCustomerProfileContracts } from "./customer-profile-contracts";
import { governanceFingerprint } from "./governance/contracts";

type JsonObject = Record<string, unknown>;

export type NormalizedCustomerProfileFieldV1 = {
  path: string;
  value: unknown;
  provenance: CustomerProfileFieldProvenanceV1;
};

export type NormalizedCustomerProfileSourceV1 = {
  sourceContractId: string;
  sourceSystem: string;
  subjectId: string;
  sourceRecordRef: string;
  asOf: string;
  observedAt: string;
  productionReady: boolean;
  providerGaps: string[];
  fields: NormalizedCustomerProfileFieldV1[];
  resultFingerprint: string;
};

export type CustomerProfileSourceAuthorizationV1 = {
  inScope: boolean;
  organizationRef: string;
  principalRef: string;
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function valueAtPath(root: JsonObject, rawPath: string): unknown {
  let current: unknown = root;
  for (const segment of rawPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    current = (current as JsonObject)[segment];
  }
  return current;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function absent(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function numericLeaves(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value as JsonObject)
    .flatMap(numericLeaves)
    .filter(item => Number.isFinite(item));
}

function amountBand(value: unknown): string | undefined {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  if (amount < 100_000) return "lt_100k";
  if (amount < 500_000) return "100k_500k";
  if (amount < 1_000_000) return "500k_1m";
  if (amount < 5_000_000) return "1m_5m";
  if (amount < 10_000_000) return "5m_10m";
  return "gte_10m";
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

function maskedPhone(value: unknown): string | undefined {
  const phone = String(value ?? "").replace(/\s+/gu, "");
  if (!phone) return undefined;
  if (phone.length < 7) return "***";
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function maskedVehicle(value: unknown): string | undefined {
  let text = String(value ?? "")
    .trim()
    .slice(0, 300);
  if (!text) return undefined;
  text = text.replace(
    /([\u4eac\u6d25\u6caa\u6e1d\u5180\u8c6b\u4e91\u8fbd\u9ed1\u6e58\u7696\u9c81\u65b0\u82cf\u6d59\u8d63\u9102\u6842\u7518\u664b\u8499\u9655\u5409\u95fd\u8d35\u7ca4\u9752\u85cf\u5ddd\u5b81\u743c][A-Z])([A-Z0-9]{4,6})/gu,
    (_match, prefix: string, suffix: string) =>
      `${prefix}****${suffix.slice(-1)}`
  );
  text = text.replace(
    /\b([A-HJ-NPR-Z0-9]{3})[A-HJ-NPR-Z0-9]{10}([A-HJ-NPR-Z0-9]{4})\b/gu,
    "$1**********$2"
  );
  return text;
}

function normalizedDate(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function transformValue(transform: string, value: unknown): unknown {
  if (absent(value)) return undefined;
  if (
    [
      "string",
      "opaque_subject_ref",
      "opaque_ref",
      "code_to_occupation_category",
      "code_to_customer_tier",
      "code_to_risk_preference",
      "normalize_occupation",
      "city_only",
    ].includes(transform)
  ) {
    return String(value).trim().slice(0, 500) || undefined;
  }
  if (transform === "constant") return String(value).trim() || undefined;
  if (transform === "boolean")
    return typeof value === "boolean" ? value : undefined;
  if (transform === "integer") {
    const number = Number(value);
    return Number.isInteger(number) ? number : undefined;
  }
  if (transform === "age_to_band") return ageBand(value);
  if (transform === "mask_phone") return maskedPhone(value);
  if (transform === "date") return normalizedDate(value);
  if (transform === "amount_to_aum_band") return amountBand(value);
  if (transform === "code_to_risk_level") {
    const level = String(value).trim().toUpperCase();
    return /^[1-5]$/u.test(level) ? `C${level}` : level.slice(0, 32);
  }
  if (transform === "summary")
    return String(value).trim().slice(0, 500) || undefined;
  if (transform === "parse_vehicle_summary") {
    const summary = maskedVehicle(value);
    return summary ? [{ summary }] : undefined;
  }
  if (transform === "mileage_to_band") {
    const mileage = Number(String(value).replace(/[^0-9.]/gu, ""));
    if (!Number.isFinite(mileage) || mileage < 0) return undefined;
    if (mileage < 5_000) return "lt_5k";
    if (mileage < 10_000) return "5k_10k";
    if (mileage < 20_000) return "10k_20k";
    return "gte_20k";
  }
  if (transform === "text_to_string_array") {
    if (Array.isArray(value))
      return value
        .map(item => String(item).trim())
        .filter(Boolean)
        .slice(0, 20);
    return String(value)
      .split(/[,，;；\n]/u)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  if (transform === "balances_to_minimized_summary") {
    const values = numericLeaves(value).filter(item => item >= 0);
    if (!values.length) return undefined;
    return `available_fields:${values.length}`;
  }
  return undefined;
}

function sourceValue(input: {
  mapping: CustomerProfileSourceContractV1["mappings"][number];
  payload: JsonObject;
  authorization: CustomerProfileSourceAuthorizationV1;
}) {
  const sourcePath = input.mapping.sourcePath;
  if (sourcePath.startsWith("$constant."))
    return sourcePath.slice("$constant.".length);
  if (sourcePath.startsWith("$authorization."))
    return valueAtPath(
      input.authorization as unknown as JsonObject,
      sourcePath.slice("$authorization.".length)
    );
  return valueAtPath(input.payload, sourcePath);
}

function sourceAsOf(payload: JsonObject): string {
  const data = object(payload.data);
  return firstString(
    payload.dataAsOf,
    payload.data_as_of,
    payload.asOf,
    payload.as_of,
    payload.updatedAt,
    payload.updated_at,
    data.dataAsOf,
    data.updatedAt,
    data.updated_at
  );
}

export function normalizeCustomerProfileSource(input: {
  sourceContractId: string;
  payload: JsonObject;
  authorization: CustomerProfileSourceAuthorizationV1;
  observedAt?: string;
  root?: string;
}): NormalizedCustomerProfileSourceV1 {
  const { sourceMappings } = loadCustomerProfileContracts(
    input.root || process.cwd()
  );
  const source = sourceMappings.sources.find(
    item => item.sourceContractId === input.sourceContractId
  );
  if (!source)
    throw new Error(
      `CUSTOMER_PROFILE_SOURCE_CONTRACT_UNKNOWN:${input.sourceContractId}`
    );

  const observedAt = input.observedAt || new Date().toISOString();
  const asOf = sourceAsOf(input.payload) || observedAt;
  const subjectMapping = source.mappings.find(
    mapping => mapping.targetPath === "subject.subjectId"
  );
  const subjectId = subjectMapping
    ? String(
        transformValue(
          subjectMapping.transform,
          sourceValue({
            mapping: subjectMapping,
            payload: input.payload,
            authorization: input.authorization,
          })
        ) ?? ""
      ).trim()
    : "";
  const sourceRecordRef = subjectId
    ? `${source.sourceSystem}:${createHash("sha256")
        .update(subjectId)
        .digest("hex")
        .slice(0, 24)}`
    : `${source.sourceSystem}:unresolved`;

  const fields: NormalizedCustomerProfileFieldV1[] = [];
  for (const mapping of source.mappings) {
    const value = transformValue(
      mapping.transform,
      sourceValue({
        mapping,
        payload: input.payload,
        authorization: input.authorization,
      })
    );
    if (absent(value)) continue;
    fields.push({
      path: mapping.targetPath,
      value,
      provenance: {
        sourceSystem: source.sourceSystem,
        sourceRecordRef,
        asOf,
        observedAt,
        mappingRuleVersion: sourceMappings.mappingSetVersion,
      },
    });
  }

  const normalized: NormalizedCustomerProfileSourceV1 = {
    sourceContractId: source.sourceContractId,
    sourceSystem: source.sourceSystem,
    subjectId,
    sourceRecordRef,
    asOf,
    observedAt,
    productionReady: source.productionReady,
    providerGaps: [...source.providerGaps],
    fields,
    resultFingerprint: "",
  };
  normalized.resultFingerprint = customerProfileSourceFingerprint(normalized);
  return normalized;
}

export function customerProfileSourceFingerprint(
  source: Pick<
    NormalizedCustomerProfileSourceV1,
    "sourceContractId" | "sourceRecordRef" | "asOf" | "fields"
  >
): string {
  return governanceFingerprint({
    sourceContractId: source.sourceContractId,
    sourceRecordRef: source.sourceRecordRef,
    asOf: source.asOf,
    fields: source.fields,
  });
}

export function customerProfileSourceContract(
  sourceContractId: string,
  root = process.cwd()
): CustomerProfileSourceContractV1 | null {
  return (
    loadCustomerProfileContracts(root).sourceMappings.sources.find(
      item => item.sourceContractId === sourceContractId
    ) || null
  );
}
