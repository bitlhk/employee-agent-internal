import { File } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectSkillPackage } from "./skill-package-upload";

describe("skill package upload transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries one queue-full response using Retry-After", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "busy" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        skill: { skillId: "demo", displayName: "演示技能" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectSkillPackage(
      new File(["skill"], "demo.skill") as unknown as globalThis.File,
      "lgj-training",
    );

    expect(result.skill.skillId).toBe("demo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a validation error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid package" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(inspectSkillPackage(
      new File(["bad"], "bad.skill") as unknown as globalThis.File,
      "lgj-training",
    )).rejects.toThrow("invalid package");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
