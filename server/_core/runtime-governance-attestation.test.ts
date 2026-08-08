import { beforeEach, describe, expect, it } from "vitest";
import {
  recordRuntimeGovernanceInvocation,
  resetRuntimeGovernanceAttestationsForTest,
  runtimeGovernanceAttestationStatus,
} from "./runtime-governance-attestation";

describe("runtime governance attestation", () => {
  beforeEach(() => resetRuntimeGovernanceAttestationsForTest());

  it("is unattested until a real hook invocation is observed", () => {
    expect(runtimeGovernanceAttestationStatus("runtime-a")).toMatchObject({
      attested: false,
      invocationCount: 0,
    });
    recordRuntimeGovernanceInvocation({ runtimeId: "runtime-a", hookVersion: "ea-governance-v1" });
    expect(runtimeGovernanceAttestationStatus("runtime-a")).toMatchObject({
      attested: true,
      hookVersion: "ea-governance-v1",
      invocationCount: 1,
    });
  });
});
