import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryGraphView } from "./MemoryGraphView";

describe("MemoryGraphView", () => {
  it("renders traceable L1, L2 and L3 nodes", () => {
    const now = new Date().toISOString();
    const html = renderToStaticMarkup(React.createElement(MemoryGraphView, {
      items: [
        { id: 1, kind: "preference", status: "active", content: "先给结论", evidenceCount: 2, updatedAt: now },
        { id: 2, kind: "procedure", status: "active", content: "先核验数据", evidenceCount: 2, updatedAt: now },
      ],
      evidence: [
        { id: 11, memoryId: 1, channel: "web", snippet: "以后先给结论", observedAt: now },
        { id: 12, memoryId: 2, channel: "feishu", snippet: null, observedAt: now },
      ],
      syntheses: [{
        id: 21,
        slot: "playbook",
        content: "形成结论优先且先核验数据的工作方法",
        memoryIds: [1, 2],
        confidence: 90,
        generatedAt: now,
      }],
    }));
    expect(html).toContain("synthesis-21");
    expect(html).toContain("memory-1");
    expect(html).toContain("evidence-11");
    expect(html).toContain("综合认知");
    expect(html).toContain("记忆事实");
    expect(html).toContain("原始事件");
    expect(html).toContain("悬停节点可预览记忆");
  });
});
