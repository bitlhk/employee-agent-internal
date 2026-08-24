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
    expect(assertSharedBindingValidationSnapshot(snapshot, "ccf1a10b181bbf1955b3605a8bfc0d9772a91224e7a45e9c8da304181995cbc7"))
      .toMatchObject({ organizationId: "org_role_scale_shadow_20260824", stage: "shadow" });
  });

  it("rejects a silent change to the frozen contract", () => {
    const snapshot = JSON.parse(readFileSync(baselinePath, "utf8")) as SharedBindingValidationSnapshotV1;
    snapshot.bindings[0].bindingVersion = "changed";
    expect(() => assertSharedBindingValidationSnapshot(snapshot))
      .toThrow("SHARED_BINDING_SNAPSHOT_FINGERPRINT_MISMATCH");
  });
});
