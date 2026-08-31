import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSkillValueEvaluationAllowedTools,
  SKILL_VALUE_EVALUATION_TOOL_SCOPE_FILE,
  writeSkillValueEvaluationToolScope,
} from "./skill-value-evaluation-tool-scope";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Skill value evaluation tool scope", () => {
  it("persists and reads the exact declared tools for each MCP server", () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "skill-eval-tools-"));
    roots.push(workspaceDir);

    writeSkillValueEvaluationToolScope({
      workspaceDir,
      mcpServers: [
        {
          serverId: "platform_tools",
          requiredTools: ["prepare_wealth_allocation_context", "get_wealth_policy_basis", "get_wealth_policy_basis"],
        },
        { serverId: "customer_context", requiredTools: ["search_customers"] },
      ],
    });

    expect(Array.from(readSkillValueEvaluationAllowedTools(workspaceDir, "platform_tools") || []))
      .toEqual(["get_wealth_policy_basis", "prepare_wealth_allocation_context"]);
    expect(readSkillValueEvaluationAllowedTools(workspaceDir, "missing")).toBeNull();
    expect(JSON.parse(readFileSync(
      path.join(workspaceDir, SKILL_VALUE_EVALUATION_TOOL_SCOPE_FILE),
      "utf8",
    ))).toMatchObject({ version: 1 });
  });
});
