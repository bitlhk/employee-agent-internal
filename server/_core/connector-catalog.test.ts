import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG_TEMPLATES,
  connectorCatalogEntry,
  visibleConnectorCatalogTemplates,
} from "../../shared/connector-catalog";

describe("connector catalog", () => {
  it("keeps connector ids unique", () => {
    const ids = CONNECTOR_CATALOG_TEMPLATES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses the same entry for UI metadata and OAuth configuration", () => {
    const notion = connectorCatalogEntry("notion");
    expect(notion).toMatchObject({ name: "Notion", oauthCatalogId: "notion" });
    expect(notion?.oauth?.endpointUrl).toBe("https://mcp.notion.com/mcp");
  });

  it("keeps compatibility-only entries out of the market", () => {
    expect(connectorCatalogEntry("atlassian")).not.toBeNull();
    expect(visibleConnectorCatalogTemplates().some((entry) => entry.id === "atlassian")).toBe(false);
  });
});
