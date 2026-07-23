import { describe, expect, it } from "vitest";
import { connectorLogo } from "./ConnectorIcon";

describe("connectorLogo", () => {
  it("uses the Wind logo for every Wind MCP server", () => {
    expect(connectorLogo({ serverId: "wind_index_data" })?.src).toBe("/images/connectors/wind-logo.png");
  });

  it("keeps the catalog brand for a generated custom MCP server id", () => {
    expect(connectorLogo({ serverId: "custom_user_42", source: "personal", catalogId: "yingmi" })?.src)
      .toBe("/images/connectors/yingmi-logo.png");
  });

  it("uses the Feishu brand for the platform channel connector", () => {
    expect(connectorLogo({ serverId: "platform:feishu" })?.src).toBe("/images/connectors/feishu-logo.png");
  });
});
