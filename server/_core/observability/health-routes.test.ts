import { describe, expect, it } from "vitest";
import { evaluateReadiness } from "./health-routes";

describe("operational readiness", () => {
  it("is ready when required dependencies are healthy", async () => {
    const result = await evaluateReadiness({
      database: async () => true,
      knowledge: async () => true,
      jiuwenswarm: async () => ({ required: true, ok: true }),
    });
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("fails closed for required dependencies and skips disabled runtime", async () => {
    const result = await evaluateReadiness({
      database: async () => false,
      knowledge: async () => true,
      jiuwenswarm: async () => ({ required: false, ok: true }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.status)).toEqual(["failed", "ok", "disabled"]);
  });
});
