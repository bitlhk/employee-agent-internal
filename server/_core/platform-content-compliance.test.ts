import { describe, expect, it } from "vitest";
import { PLATFORM_CONTENT_COMPLIANCE_POLICY } from "./platform-content-compliance";
import { buildChatRequestBody } from "./tool_schema";

describe("platform content compliance policy", () => {
  it("is injected into the server-managed legacy system prompt", () => {
    const body = buildChatRequestBody({
      message: "请分析一段公共事件材料",
      permissionProfile: "starter",
    });

    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain(PLATFORM_CONTENT_COMPLIANCE_POLICY);
    expect(body.messages[0].content).toContain("客观、中性、建设性");
  });
});
