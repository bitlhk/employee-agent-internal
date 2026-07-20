import { describe, expect, it } from "vitest";
import type { EffectiveRoleAssets } from "./role-asset-grants";
import {
  projectEffectiveAssetsToMcpSelection,
  resolveAgentMcpSelection,
} from "./agent-mcp-selection";

const assets: EffectiveRoleAssets = {
  skills: { default: ["role-skill"], optional: ["extra-skill"] },
  mcpServers: { default: ["customer_data"], optional: ["market_data"] },
};

describe("agent MCP selection", () => {
  it("keeps all role-authorized servers enabled when no preference exists", () => {
    expect(resolveAgentMcpSelection(assets, [])).toEqual({
      authorizedServerIds: ["customer_data", "market_data"],
      enabledServerIds: ["customer_data", "market_data"],
      disabledServerIds: [],
      grantModeByServerId: {
        customer_data: "default",
        market_data: "optional",
      },
    });
  });

  it("only narrows authorized servers and ignores stale or unauthorized preferences", () => {
    const result = resolveAgentMcpSelection(assets, [
      { serverId: "customer_data", enabled: false },
      { serverId: "unrelated_internal_service", enabled: true },
    ]);

    expect(result.enabledServerIds).toEqual(["market_data"]);
    expect(result.disabledServerIds).toEqual(["customer_data"]);
    expect(result.authorizedServerIds).not.toContain("unrelated_internal_service");
  });

  it("projects MCP scope without changing skill grants", () => {
    expect(projectEffectiveAssetsToMcpSelection(assets, ["market_data"])).toEqual({
      skills: assets.skills,
      mcpServers: { default: [], optional: ["market_data"] },
    });
  });
});
