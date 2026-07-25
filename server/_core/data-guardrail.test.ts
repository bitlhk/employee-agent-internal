import { describe, expect, it } from "vitest";
import {
  detectSensitiveData,
  isValidChineseIdCard,
  isValidLuhnNumber,
  protectExternalText,
  redactSensitiveData,
} from "./data-guardrail";

describe("data guardrail", () => {
  it("validates Chinese identity-card dates and checksums", () => {
    expect(isValidChineseIdCard("11010519491231002X")).toBe(true);
    expect(isValidChineseIdCard("110105194912310021")).toBe(false);
    expect(isValidChineseIdCard("110105199902300021")).toBe(false);
    expect(
      detectSensitiveData("证件 11010519491231002X").map(item => item.type)
    ).toContain("cn_id_card");
    expect(
      detectSensitiveData("普通编号 110105199001011234").map(item => item.type)
    ).not.toContain("cn_id_card");
  });

  it("requires Luhn validation and nearby bank-card context by default", () => {
    expect(isValidLuhnNumber("4111 1111 1111 1111")).toBe(true);
    expect(isValidLuhnNumber("4111 1111 1111 1112")).toBe(false);
    expect(
      detectSensitiveData("银行卡号 4111 1111 1111 1111").map(item => item.type)
    ).toContain("bank_card");
    expect(
      detectSensitiveData("订单号 4111111111111111").map(item => item.type)
    ).not.toContain("bank_card");
    expect(
      detectSensitiveData("银行卡号 4111111111111112").map(item => item.type)
    ).not.toContain("bank_card");
  });

  it("redacts high-confidence personal information", () => {
    const decision = protectExternalText(
      "联系 13800138000，身份证 11010519491231002X，银行卡号 4111111111111111",
      { mode: "enforce" }
    );
    expect(decision.action).toBe("redact");
    expect(decision.text).toContain("[REDACTED_PHONE]");
    expect(decision.text).toContain("[REDACTED_ID]");
    expect(decision.text).toContain("[REDACTED_BANK_CARD]");
    expect(decision.text).not.toContain("13800138000");
  });

  it("blocks credentials and private keys from external delivery", () => {
    expect(
      protectExternalText("api_key=secret-value-123456", { mode: "enforce" })
        .action
    ).toBe("block");
    expect(
      protectExternalText('{"api_key":"secret-value-123456"}', {
        mode: "enforce",
      }).action
    ).toBe("block");
    expect(
      protectExternalText("密码: Abc123!", { mode: "enforce" }).action
    ).toBe("block");
    expect(
      protectExternalText("密码策略：请设置强密码", { mode: "enforce" }).action
    ).toBe("allow");
    expect(
      protectExternalText(
        "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
        { mode: "enforce" }
      ).action
    ).toBe("block");
  });

  it("supports monitor and off modes without modifying text", () => {
    const input = "手机号 13800138000";
    const monitored = protectExternalText(input, { mode: "monitor" });
    expect(monitored.action).toBe("allow");
    expect(monitored.text).toBe(input);
    expect(monitored.types).toEqual(["cn_phone"]);
    expect(protectExternalText(input, { mode: "off" })).toEqual({
      action: "allow",
      text: input,
      detections: [],
      types: [],
      changed: false,
    });
  });

  it("can redact standalone Luhn values in protected storage paths", () => {
    const decision = redactSensitiveData("4111111111111111", {
      requireBankCardContext: false,
    });
    expect(decision.text).toBe("[REDACTED_BANK_CARD]");
  });
});
