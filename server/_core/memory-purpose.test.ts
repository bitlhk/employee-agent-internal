import { describe, expect, it } from "vitest";
import {
  canonicalPurposeIdForRoleTemplate,
  isPurposeScopedRecordVisible,
  type MemoryRetrievalScopeV1,
  type PurposeScopedRecordV1,
} from "../../shared/memory-purpose";

const wealth: MemoryRetrievalScopeV1 = {
  organizationId: "org-a",
  userId: 7,
  adoptionId: "lgj-wealth",
  roleTemplate: "wealth-manager",
  rolePackId: "linggan-bank.wealth-manager",
  purposeId: "wealth_advisory",
  requestedPurpose: "财富客户经营",
  subjectId: "customer-001",
};

function record(patch: Partial<PurposeScopedRecordV1> = {}): PurposeScopedRecordV1 {
  return {
    organizationId: "org-a",
    userId: 7,
    adoptionId: "lgj-wealth",
    roleTemplate: "wealth-manager",
    visibilityClass: "principal_private",
    purposeIds: ["wealth_advisory"],
    subjectId: null,
    purposeScopeVersion: "1",
    ...patch,
  };
}

describe("governed memory Purpose scope", () => {
  it("uses stable Purpose IDs for the two validated roles", () => {
    expect(canonicalPurposeIdForRoleTemplate("wealth-manager")).toBe("wealth_advisory");
    expect(canonicalPurposeIdForRoleTemplate("insurance-advisor")).toBe("insurance_advisory");
  });

  it("keeps principal-private and role-private records within their declared boundary", () => {
    expect(isPurposeScopedRecordVisible(record(), wealth)).toBe(true);
    expect(isPurposeScopedRecordVisible(record(), { ...wealth, userId: 8 })).toBe(false);
    expect(isPurposeScopedRecordVisible(record({ visibilityClass: "role_private" }), { ...wealth, userId: 8, adoptionId: "lgj-wealth-2" })).toBe(true);
    expect(isPurposeScopedRecordVisible(record({ visibilityClass: "role_private" }), { ...wealth, roleTemplate: "insurance-advisor" })).toBe(false);
  });

  it("shares only records that include the requested Purpose and matching subject", () => {
    const shared = record({
      visibilityClass: "enterprise_shared",
      purposeIds: ["wealth_advisory", "insurance_advisory"],
      subjectId: "customer-001",
    });
    expect(isPurposeScopedRecordVisible(shared, wealth)).toBe(true);
    expect(isPurposeScopedRecordVisible(shared, {
      ...wealth,
      userId: 8,
      adoptionId: "lgj-insurance",
      roleTemplate: "insurance-advisor",
      purposeId: "insurance_advisory",
    })).toBe(true);
    expect(isPurposeScopedRecordVisible(shared, { ...wealth, purposeId: "claims_review" })).toBe(false);
    expect(isPurposeScopedRecordVisible(shared, { ...wealth, subjectId: "customer-002" })).toBe(false);
    expect(isPurposeScopedRecordVisible(shared, { ...wealth, organizationId: "org-b" })).toBe(false);
  });

  it("fails closed for legacy records without explicit Purpose provenance", () => {
    expect(isPurposeScopedRecordVisible(record({ organizationId: null, purposeIds: [] }), wealth)).toBe(false);
  });
});
