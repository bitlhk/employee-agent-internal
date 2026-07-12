import { describe, expect, it } from "vitest";

import { cleanA2AText } from "./claw-agent-tasks";

describe("cleanA2AText", () => {
  it("renders embedded structured tool output without business-specific interpretation", () => {
    const result = cleanA2AText(
      `trace data={'content': '{"record":"example","score":88,"status":"ready"}'} error=None`,
    );

    expect(result).toContain("```json");
    expect(result).toContain('"score": 88');
    expect(result).toContain('"status": "ready"');
  });

  it("preserves the final Markdown response after tool traces", () => {
    const result = cleanA2AText("trace\n[tool_result]\n# Final answer\n\nDone");

    expect(result).toBe("# Final answer\n\nDone");
  });
});
