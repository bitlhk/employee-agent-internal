import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { governanceFingerprint } from "../governance/contracts";

const EVIDENCE_PATH = "examples/insurance-advisor-reference-role-pack/eval/shared-binding-gate-b-blocked.v1.json";
const EXPECTED_EVIDENCE_FINGERPRINT = "3789490573299b561a6cbb0ddff614e0e5ccc9fb156be641e2d540da5aff90f8";

describe("Enterprise-shared Binding Gate B blocked evidence", () => {
  it("is immutable and records a non-promoted environment dependency block", () => {
    const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as Record<string, unknown>;
    const evidenceFingerprint = evidence.evidenceFingerprint;
    delete evidence.evidenceFingerprint;

    expect(governanceFingerprint(evidence)).toBe(EXPECTED_EVIDENCE_FINGERPRINT);
    expect(evidenceFingerprint).toBe(EXPECTED_EVIDENCE_FINGERPRINT);
    expect(evidence.status).toBe("core_validation_pass_environment_dependency_blocked");
    expect(evidence.promotionPerformed).toBe(false);
  });
});
