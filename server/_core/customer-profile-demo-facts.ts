import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  customerProfileSourceFingerprint,
  type NormalizedCustomerProfileSourceV1,
} from "./customer-profile-source-adapters";

const FACTS_PATH =
  "examples/customer-profile-contract-v1/demo-insurance-facts.v1.json";

type DemoFactsPackV1 = {
  schemaVersion: "ea.demo-insurance-customer-facts.v1";
  factsVersion: string;
  status: "synthetic_demo";
  containsRealCustomerData: false;
  sourceSystem: "grace_demo_insurance_facts";
  businessAsOf: string;
  records: Array<{
    subjectId: string;
    renewalAt: string;
    renewalStatus: string;
    currentCoverageSummary: string;
    claimsRiskSummary: string;
  }>;
};

let cachedPack: DemoFactsPackV1 | null = null;

function factsPack(root = process.cwd()): DemoFactsPackV1 {
  if (cachedPack) return cachedPack;
  const parsed = JSON.parse(
    readFileSync(resolve(root, FACTS_PATH), "utf8")
  ) as DemoFactsPackV1;
  if (
    parsed.schemaVersion !== "ea.demo-insurance-customer-facts.v1" ||
    parsed.status !== "synthetic_demo" ||
    parsed.containsRealCustomerData !== false ||
    !Number.isFinite(Date.parse(parsed.businessAsOf))
  ) {
    throw new Error("CUSTOMER_PROFILE_DEMO_FACTS_INVALID");
  }
  const ids = parsed.records.map(record => String(record.subjectId).trim());
  if (ids.some(id => !id) || new Set(ids).size !== ids.length)
    throw new Error("CUSTOMER_PROFILE_DEMO_FACTS_SUBJECT_INVALID");
  cachedPack = parsed;
  return parsed;
}

export function loadDemoInsuranceCustomerFacts(input: {
  subjectId: string;
  organizationRef: string;
  principalRef: string;
  observedAt?: string;
  root?: string;
}): NormalizedCustomerProfileSourceV1 | null {
  const pack = factsPack(input.root);
  const record = pack.records.find(
    item => item.subjectId === String(input.subjectId).trim()
  );
  if (!record) return null;
  const observedAt = input.observedAt || new Date().toISOString();
  const sourceRecordRef = `${pack.sourceSystem}:subject-${record.subjectId}`;
  const provenance = {
    sourceSystem: pack.sourceSystem,
    sourceRecordRef,
    asOf: pack.businessAsOf,
    observedAt,
    mappingRuleVersion: pack.factsVersion,
  };
  const source: NormalizedCustomerProfileSourceV1 = {
    sourceContractId: "grace-demo-insurance-facts-v1",
    sourceSystem: pack.sourceSystem,
    subjectId: record.subjectId,
    sourceRecordRef,
    asOf: pack.businessAsOf,
    observedAt,
    productionReady: false,
    assuranceLevel: "demo",
    providerGaps: [
      "Synthetic Demo facts must never satisfy a Production gate.",
    ],
    fields: [
      { path: "serviceScope.inScope", value: true, provenance },
      { path: "insurance.renewalAt", value: record.renewalAt, provenance },
      {
        path: "insurance.renewalStatus",
        value: record.renewalStatus,
        provenance,
      },
      {
        path: "insurance.currentCoverageSummary",
        value: record.currentCoverageSummary,
        provenance,
      },
      {
        path: "insurance.claimsRiskSummary",
        value: record.claimsRiskSummary,
        provenance,
      },
    ],
    resultFingerprint: "",
  };
  source.resultFingerprint = customerProfileSourceFingerprint(source);
  return source;
}

export function buildDemoWealthCustomerFacts(input: {
  subjectId: string;
  observedAt?: string;
}): NormalizedCustomerProfileSourceV1 {
  const subjectId = String(input.subjectId || "").trim();
  if (!subjectId) throw new Error("CUSTOMER_PROFILE_DEMO_FACTS_SUBJECT_INVALID");
  const observedAt = input.observedAt || new Date().toISOString();
  const asOf = "2026-08-24T09:00:00.000Z";
  const sourceSystem = "grace_demo_wealth_facts";
  const sourceRecordRef = `${sourceSystem}:subject-${subjectId}`;
  const provenance = {
    sourceSystem,
    sourceRecordRef,
    asOf,
    observedAt,
    mappingRuleVersion: "1.0.0",
  };
  const source: NormalizedCustomerProfileSourceV1 = {
    sourceContractId: "grace-demo-wealth-facts-v1",
    sourceSystem,
    subjectId,
    sourceRecordRef,
    asOf,
    observedAt,
    productionReady: false,
    assuranceLevel: "demo",
    providerGaps: ["Synthetic Demo facts must never satisfy a Production assurance gate."],
    fields: [
      {
        path: "subject.customerStatus",
        value: "active_demo",
        provenance,
      },
      {
        path: "relationship.recentContactSummary",
        value: "Demo: recent follow-up status requires advisor confirmation.",
        provenance,
      },
    ],
    resultFingerprint: "",
  };
  source.resultFingerprint = customerProfileSourceFingerprint(source);
  return source;
}

export function applyDemoWealthCustomerScenario(
  source: NormalizedCustomerProfileSourceV1
): NormalizedCustomerProfileSourceV1 {
  if (source.subjectId !== "C005") return source;
  const asOf = "2026-08-25T09:00:00.000Z";
  const sourceSystem = "grace_demo_wealth_scenario";
  const sourceRecordRef = `${sourceSystem}:subject-C005`;
  const fields = source.fields.map(field =>
    field.path === "risk.investmentRiskValidUntil"
      ? {
          ...field,
          value: "2027-12-31T23:59:59.000Z",
          provenance: {
            sourceSystem,
            sourceRecordRef,
            asOf,
            observedAt: field.provenance.observedAt,
            mappingRuleVersion: "wealth-positive-demo-v1",
          },
        }
      : field
  );
  const updated: NormalizedCustomerProfileSourceV1 = {
    ...source,
    asOf,
    assuranceLevel: "demo",
    productionReady: false,
    providerGaps: [
      ...source.providerGaps,
      "C005 risk validity is a synthetic positive-path Demo fact and must never satisfy a Production assurance gate.",
    ],
    fields,
    resultFingerprint: "",
  };
  updated.resultFingerprint = customerProfileSourceFingerprint(updated);
  return updated;
}

export function resetDemoCustomerFactsCacheForTests(): void {
  cachedPack = null;
}
