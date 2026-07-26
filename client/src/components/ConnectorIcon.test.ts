import { describe, expect, it } from "vitest";
import { connectorIconKind } from "./ConnectorIcon";

describe("connectorIconKind", () => {
  it("uses a financial chart for every Wind MCP server", () => {
    expect(connectorIconKind({ serverId: "wind_index_data" })).toBe("chart");
  });

  it("keeps the catalog meaning for generated custom MCP server ids", () => {
    expect(
      connectorIconKind({
        serverId: "custom_user_42",
        source: "personal",
        catalogId: "yingmi",
      })
    ).toBe("wallet");
  });

  it("uses a messaging symbol for the Feishu platform channel", () => {
    expect(connectorIconKind({ serverId: "platform:feishu" })).toBe("message");
  });

  it("uses neutral semantic symbols for knowledge and creation connectors", () => {
    expect(
      connectorIconKind({ serverId: "catalog", catalogId: "google-drive" })
    ).toBe("hard-drive");
    expect(connectorIconKind({ serverId: "catalog", catalogId: "canva" })).toBe(
      "palette"
    );
    expect(
      connectorIconKind({ serverId: "catalog", catalogId: "notion" })
    ).toBe("library");
  });
});
