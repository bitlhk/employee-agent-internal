import { describe, expect, it } from "vitest";
import { classifyToolName } from "./tool-presentation";

describe("classifyToolName", () => {
  it.each([
    ["web_search", "web"],
    ["browser_navigate", "browser"],
    ["bash", "terminal"],
    ["read_file", "file"],
    ["install_skill", "skill"],
    ["mcp_call_tool", "mcp"],
    ["mysql_query", "database"],
    ["image_generate", "image"],
    ["delegate_agent", "agent"],
    ["python", "code"],
    ["unknown_tool", "generic"],
  ] as const)("maps %s to %s", (name, expected) => {
    expect(classifyToolName(name)).toBe(expected);
  });

  it("keeps skill-specific file tools under the skill visual", () => {
    expect(classifyToolName("read_skill_file")).toBe("skill");
  });
});
