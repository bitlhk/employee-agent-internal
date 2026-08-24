import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSharedBindingValidationSnapshot,
  type SharedBindingValidationSnapshotV1,
} from "./shared-binding-validation-snapshot";

const baselinePath = "examples/insurance-advisor-reference-role-pack/eval/shared-binding-validation-snapshot.v1.json";

describe("Shared Binding validation snapshot", () => {
  it("keeps the frozen Gate B snapshot immutable", () => {
    const snapshot = JSON.parse(readFileSync(baselinePath, "utf8")) as SharedBindingValidationSnapshotV1;
    expect(assertSharedBindingValidationSnapshot(snapshot, "4d115dafceca923889b0001e35a606c35dc9eca7e5e337ec7ab65cbc5bf4b2f6"))
      .toMatchObject({ organizationId: "org_linggan_finance", stage: "shadow" });
  });

  it("rejects a silent change to the frozen contract", () => {
    const snapshot = JSON.parse(readFileSync(baselinePath, "utf8")) as SharedBindingValidationSnapshotV1;
    snapshot.bindings[0].bindingVersion = "changed";
    expect(() => assertSharedBindingValidationSnapshot(snapshot))
      .toThrow("SHARED_BINDING_SNAPSHOT_FINGERPRINT_MISMATCH");
  });
});
