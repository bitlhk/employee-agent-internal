import { describe, expect, it } from "vitest";
import {
  InternalMcpResultError,
  parseInternalMcpJsonResult,
} from "./internal-mcp-client";

describe("internal MCP result parsing", () => {
  it("preserves structured provider failure evidence", () => {
    const payload = {
      status: "BLOCKED",
      reasonCodes: ["CUSTOMER_PROFILE_REQUIRED_FIELD_MISSING"],
      missingRequiredFields: [
        "preferences.investmentHorizon",
        "preferences.liquidityNeeds",
      ],
    };

    expect(() =>
      parseInternalMcpJsonResult({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      })
    ).toThrow(InternalMcpResultError);

    try {
      parseInternalMcpJsonResult({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(InternalMcpResultError);
      expect((error as InternalMcpResultError).payload).toEqual(payload);
    }
  });
});
