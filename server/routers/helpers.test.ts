import { afterEach, describe, expect, it, vi } from "vitest";
import { getFrontendModelFallbacks } from "./helpers";

describe("router helper model fallbacks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults frontend fallback models to the ModelArts GLM provider", () => {
    vi.stubEnv("LINGXIA_FRONTEND_MODEL_FALLBACKS", "");
    vi.stubEnv("FRONTEND_MODEL_FALLBACKS", "");
    vi.stubEnv("DEFAULT_FRONTEND_MODEL", "");
    vi.stubEnv("CLAW_AGENT_MODEL", "");

    expect(getFrontendModelFallbacks().map((model) => model.id)).toEqual([
      "modelarts-maas/glm-5.2",
      "maas/deepseek-v4-flash",
    ]);
  });

  it("allows deployments to override frontend fallback models", () => {
    vi.stubEnv("LINGXIA_FRONTEND_MODEL_FALLBACKS", "openai/gpt-5.5, modelarts-maas/glm-5.1");

    expect(getFrontendModelFallbacks()).toMatchObject([
      { id: "openai/gpt-5.5", isDefault: true },
      { id: "modelarts-maas/glm-5.1" },
    ]);
  });
});
