import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAgentMemoryProjection } from "./agent-memory-projection";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent memory projection", () => {
  it("reports changes only when managed workspace files change", () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "ea-memory-projection-"));
    temporaryDirectories.push(workspaceDir);
    const input = { workspaceDir, mode: "off" as const, memories: [], syntheses: [] };

    expect(writeAgentMemoryProjection(input).changed).toBe(true);
    expect(writeAgentMemoryProjection(input).changed).toBe(false);
  });
});
