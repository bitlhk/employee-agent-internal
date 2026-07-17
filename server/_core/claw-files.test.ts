import { describe, expect, it } from "vitest";

import { isWorkspaceUiVisiblePath } from "./claw-files";

describe("workspace UI file visibility", () => {
  it("hides runtime-managed roots and identity files", () => {
    for (const hiddenPath of [
      "skills",
      "skills/example/SKILL.md",
      "memory/daily_memory/2026-07-17.md",
      "prompt_attachment/upload.txt",
      "coding_memory/MEMORY.md",
      "context/session/offload/result.json",
      "todo/session/todo.json",
      "AGENT.md",
      "MEMORY.md",
      "IDENTITY.md",
      "USER.md",
    ]) {
      expect(isWorkspaceUiVisiblePath(hiddenPath)).toBe(false);
    }
  });

  it("keeps user uploads and generated artifacts visible", () => {
    for (const visiblePath of [
      "report.docx",
      "output/company-analysis.pdf",
      "uploads/source.txt",
      "sandbox-files/chart.png",
    ]) {
      expect(isWorkspaceUiVisiblePath(visiblePath)).toBe(true);
    }
  });
});
