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

  it("reserves ask_user for clarification instead of business write authorization", () => {
    const body = buildChatRequestBody({
      message: "请为客户创建一条跟进任务",
      permissionProfile: "plus",
    });

    expect(body.messages[0].content).toContain("Never use ask_user or a text question to authorize a business write");
    expect(body.messages[0].content).toContain("single official governance confirmation card");
    expect(body.messages[0].content).toContain("unchanged business parameters and idempotency key");
  });

  it("reserves customer CRM writes for the governed CRM tool", () => {
    const body = buildChatRequestBody({
      message: "请把客户跟进任务保存到 CRM",
      permissionProfile: "plus",
    });

    expect(body.messages[0].content).toContain(
      "create_customer_followup_task is available, it is the only tool"
    );
    expect(body.messages[0].content).toContain(
      "Never use demo_create_followup_task to fulfill a CRM write request"
    );
    expect(body.messages[0].content).toContain("canonical customer ID");
  });
});
