import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCoopRuntimeExecutor } from "../coop-runtime-executor";
beforeEach(() => {
  vi.stubEnv("EA_COLLABORATION_RUNTIME_ENABLED", "true");
  vi.stubEnv("JIUWENCLAW_RUNTIME_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());
describe("opt-in scheduling execution compatibility", () => {
  it("does not opt old groups, keyless requests or other task types into the new dispatcher", () => {
    for (const request of [
      undefined,
      { taskType: "scheduling" },
      { taskType: "general", requestKey: "key" },
      { taskType: "scheduling", requestKey: "key", sessionId: "old-group" },
    ])
      expect(getCoopRuntimeExecutor("jiuwenswarm", request).protocol).toBe(
        "runtime-retired"
      );
  });
  it("enables only new standalone scheduling requests on supported enabled runtimes", () => {
    const request = {
      taskType: "scheduling",
      requestKey: "key",
      sessionId: null,
    };
    expect(getCoopRuntimeExecutor("jiuwenswarm", request).protocol).toBe(
      "jiuwenswarm-collaboration-v1"
    );
    expect(getCoopRuntimeExecutor("legacy", request).protocol).toBe(
      "runtime-retired"
    );
    vi.stubEnv("EA_COLLABORATION_RUNTIME_ENABLED", "false");
    expect(getCoopRuntimeExecutor("jiuwenswarm", request).protocol).toBe(
      "runtime-retired"
    );
  });
});
