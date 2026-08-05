import { describe, expect, it } from "vitest";

import { classifyPermissionRisk } from "./permission-risk";

const persistentOptions = [
  { label: "本次允许", value: "allow_once" },
  { label: "总是允许", value: "allow_always" },
];

describe("permission risk", () => {
  it("allows runtime persistence for read-only tools", () => {
    expect(classifyPermissionRisk({ toolName: "read_file", options: persistentOptions })).toMatchObject({
      riskLevel: "low",
      reasonCode: "read_only",
      allowAlways: true,
    });
  });

  it("keeps destructive shell commands on per-use approval", () => {
    expect(classifyPermissionRisk({
      toolName: "bash",
      command: "rm -rf /tmp/example",
      options: persistentOptions,
    })).toMatchObject({ riskLevel: "high", allowAlways: false });
  });

  it("keeps external delivery on per-use approval", () => {
    expect(classifyPermissionRisk({
      toolName: "webhook_send",
      options: persistentOptions,
    })).toMatchObject({ reasonCode: "external_delivery", allowAlways: false });
  });
});
