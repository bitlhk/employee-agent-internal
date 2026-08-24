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
    expect(assertSharedBindingValidationSnapshot(snapshot, "015f9a157bc2cb5311b8d865f08cbdb768f601388894d659602192681c771e9f"))
      .toMatchObject({ organizationId: "org_linggan_finance", stage: "shadow" });
  });

  it("rejects a silent change to the frozen contract", () => {
    const snapshot = JSON.parse(readFileSync(baselinePath, "utf8")) as SharedBindingValidationSnapshotV1;
    snapshot.bindings[0].bindingVersion = "changed";
    expect(() => assertSharedBindingValidationSnapshot(snapshot))
      .toThrow("SHARED_BINDING_SNAPSHOT_FINGERPRINT_MISMATCH");
  });
});
