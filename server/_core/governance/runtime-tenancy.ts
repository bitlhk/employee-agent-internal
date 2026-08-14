import { createHash } from "node:crypto";

export type RuntimeTenancyMode = "legacy" | "demo_single_org";

export type RuntimeTenantBinding = {
  mode: RuntimeTenancyMode;
  tenantId: string;
  organizationId: string;
  displayName: string;
  identitySource: "legacy" | "personal" | "platform_demo";
  externalSubject: string;
  personal: boolean;
};

const DEFAULT_DEMO_TENANT_ID = "tn_linggan_finance";
const DEFAULT_DEMO_ORGANIZATION_ID = "org_linggan_finance";
const DEFAULT_DEMO_ORGANIZATION_NAME = "灵感金融";
const STABLE_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/u;

function stableSourceId(prefix: string, source: string): string {
  return `${prefix}_${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
}

function normalizeOrganization(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\s+/gu, " ");
}

function configuredStableId(name: string, fallback: string): string {
  const value = String(process.env[name] || fallback).trim();
  if (!STABLE_ID_PATTERN.test(value)) {
    throw new Error(`${name} must be a stable lowercase identifier`);
  }
  return value;
}

export function runtimeTenancyMode(): RuntimeTenancyMode {
  const value = String(process.env.EA_TENANCY_MODE || "legacy").trim().toLowerCase();
  if (value === "legacy" || value === "demo_single_org") return value;
  throw new Error(`Unsupported EA_TENANCY_MODE: ${value}`);
}

export function resolveRuntimeTenantBinding(input: {
  userId: number;
  organizationName?: string | null;
}): RuntimeTenantBinding {
  const mode = runtimeTenancyMode();
  if (mode === "demo_single_org") {
    return {
      mode,
      tenantId: configuredStableId("EA_DEMO_TENANT_ID", DEFAULT_DEMO_TENANT_ID),
      organizationId: configuredStableId("EA_DEMO_ORGANIZATION_ID", DEFAULT_DEMO_ORGANIZATION_ID),
      displayName: normalizeOrganization(process.env.EA_DEMO_ORGANIZATION_NAME)
        || DEFAULT_DEMO_ORGANIZATION_NAME,
      identitySource: "platform_demo",
      externalSubject: "linggan-finance-demo",
      personal: false,
    };
  }

  const organizationName = normalizeOrganization(input.organizationName);
  const personal = !organizationName;
  const organizationSeed = personal
    ? `personal-user:${input.userId}`
    : organizationName.toLowerCase();
  return {
    mode,
    tenantId: stableSourceId("tn", organizationSeed),
    organizationId: stableSourceId(personal ? "org_personal" : "org", organizationSeed),
    displayName: organizationName || `Personal workspace ${input.userId}`,
    identitySource: personal ? "personal" : "legacy",
    externalSubject: personal ? `user:${input.userId}` : organizationSeed,
    personal,
  };
}
