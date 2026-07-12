import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("OpenClaw provision policy", () => {
  it("defaults shell execution to a fail-closed allowlist", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts", "claw-provision.sh"), "utf8");
    expect(script).toContain('"exec": {"ask": "off", "security": "allowlist"}');
    expect(script).not.toContain('"exec": {"ask": "off", "security": "full"}');
    expect(script).not.toMatch(/<<'PY'\s*\|\|/);
  });
});
