import { describe, expect, it } from "vitest";
import { findCitationMatch, normalizeCitationText } from "./KnowledgeCitationPanel";

describe("KnowledgeCitationPanel", () => {
  it("matches citation text after normalizing PDF whitespace and quotation marks", () => {
    const page = "公司采用 IDM 模式开展经营，能够高效响应客户需求。";
    const locator = "公司采用“IDM”模式开展经营，能够高效响应客户需求。";
    const match = findCitationMatch(page, locator);
    expect(match).not.toBeNull();
    expect(match?.end).toBeGreaterThan(match?.start || 0);
  });

  it("does not report unrelated text as a match", () => {
    expect(findCitationMatch("市场份额为 7.67%", "环境保护风险")).toBeNull();
    expect(normalizeCitationText(" 第 117 页 ")).toBe("第117页");
  });
});
