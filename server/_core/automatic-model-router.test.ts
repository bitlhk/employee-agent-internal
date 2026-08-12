import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inferModelCapabilities } from "../../shared/model-capabilities";
import {
  acquireAutomaticModel,
  resetAutomaticModelRouterForTests,
} from "./automatic-model-router";
import type { SelectableJiuwenModel } from "./jiuwenswarm-model-admin";

function model(modelName: string): SelectableJiuwenModel {
  return {
    id: modelName,
    name: modelName,
    description: "test",
    modelName,
    alias: "",
    provider: "OpenAI",
    isDefault: modelName === "model-a",
    runtimeModelId: modelName,
    capabilities: inferModelCapabilities({ modelName }),
  };
}

const envKeys = [
  "JIUWEN_AUTO_ROUTING_ENABLED",
  "JIUWEN_AUTO_MODEL_POOL",
  "JIUWEN_AUTO_MODEL_FAILURE_THRESHOLD",
  "JIUWEN_AUTO_MODEL_CIRCUIT_MS",
  "JIUWEN_AUTO_MODEL_STICKY_MS",
] as const;
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));

beforeEach(() => {
  resetAutomaticModelRouterForTests();
  process.env.JIUWEN_AUTO_ROUTING_ENABLED = "true";
  process.env.JIUWEN_AUTO_MODEL_STICKY_MS = "900000";
});

afterEach(() => {
  resetAutomaticModelRouterForTests();
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("capacity-aware automatic model routing", () => {
  it("keeps a 60-request training burst within all configured lanes", () => {
    process.env.JIUWEN_AUTO_MODEL_POOL = "deepseek-v4-flash:35:24,hy3:25:18,doubao-seed-2.1-pro:20:14,glm-5.2:15:12,openpangu-2.0-flash:5:8";
    const models = [
      model("deepseek-v4-flash"),
      model("hy3"),
      model("doubao-seed-2.1-pro"),
      model("glm-5.2"),
      model("openpangu-2.0-flash"),
    ];
    const leases = Array.from({ length: 60 }, () => acquireAutomaticModel({ models }));
    expect(leases.every(Boolean)).toBe(true);
    const counts = new Map<string, number>();
    for (const lease of leases) counts.set(lease!.model.id, (counts.get(lease!.model.id) || 0) + 1);
    expect(counts.size).toBe(5);
    expect(counts.get("deepseek-v4-flash")).toBeLessThanOrEqual(24);
    expect(counts.get("hy3")).toBeLessThanOrEqual(18);
    expect(counts.get("doubao-seed-2.1-pro")).toBeLessThanOrEqual(14);
    expect(counts.get("glm-5.2")).toBeLessThanOrEqual(12);
    expect(counts.get("openpangu-2.0-flash")).toBeLessThanOrEqual(8);
    for (const lease of leases) lease?.complete("success");
  });

  it("spreads a burst across bounded model lanes", () => {
    process.env.JIUWEN_AUTO_MODEL_POOL = "model-a:3:2,model-b:2:2,model-c:1:2";
    const models = [model("model-a"), model("model-b"), model("model-c")];
    const leases = Array.from({ length: 6 }, () =>
      acquireAutomaticModel({ models })
    );
    const counts = new Map<string, number>();
    for (const lease of leases) {
      expect(lease).not.toBeNull();
      counts.set(lease!.model.id, (counts.get(lease!.model.id) || 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      "model-a": 2,
      "model-b": 2,
      "model-c": 2,
    });
    for (const lease of leases) lease?.complete("success");
  });

  it("keeps a healthy conversation on its selected model", () => {
    process.env.JIUWEN_AUTO_MODEL_POOL = "model-a:3:4,model-b:2:4";
    const models = [model("model-a"), model("model-b")];
    const first = acquireAutomaticModel({
      models,
      stickyKey: "adopt:conversation",
    });
    expect(first?.routeReason).toBe("least_loaded");
    first?.complete("success");

    const second = acquireAutomaticModel({
      models,
      stickyKey: "adopt:conversation",
    });
    expect(second?.model.id).toBe(first?.model.id);
    expect(second?.routeReason).toBe("sticky");
    second?.complete("success");
  });

  it("does not exceed configured model lane capacity", () => {
    process.env.JIUWEN_AUTO_MODEL_POOL = "model-a:1:1";
    const models = [model("model-a")];
    const active = acquireAutomaticModel({ models });
    expect(active?.model.id).toBe("model-a");
    expect(acquireAutomaticModel({ models })).toBeNull();
    active?.complete("success");
    expect(acquireAutomaticModel({ models })?.model.id).toBe("model-a");
  });

  it("ejects a repeatedly failing route and selects another model", () => {
    process.env.JIUWEN_AUTO_MODEL_POOL = "model-a:10:4,model-b:1:4";
    process.env.JIUWEN_AUTO_MODEL_FAILURE_THRESHOLD = "1";
    process.env.JIUWEN_AUTO_MODEL_CIRCUIT_MS = "30000";
    const models = [model("model-a"), model("model-b")];
    const failed = acquireAutomaticModel({ models, now: 1000 });
    expect(failed?.model.id).toBe("model-a");
    failed?.complete("error");

    const replacement = acquireAutomaticModel({ models, now: Date.now() });
    expect(replacement?.model.id).toBe("model-b");
    replacement?.complete("success");
  });

  it("falls back to the configured target when capacity routing is disabled", () => {
    process.env.JIUWEN_AUTO_ROUTING_ENABLED = "false";
    process.env.JIUWEN_AUTO_TARGET_MODEL = "model-b";
    const lease = acquireAutomaticModel({
      models: [model("model-a"), model("model-b")],
    });
    expect(lease?.model.id).toBe("model-b");
    expect(lease?.routeReason).toBe("fallback");
    lease?.complete("success");
    delete process.env.JIUWEN_AUTO_TARGET_MODEL;
  });
});
