import { describe, expect, it } from "vitest";
import type { AgentMemoryRecord } from "../db";
import {
  renderRelevantAgentMemoryContext,
  selectCoreAgentMemories,
  selectRelevantAgentMemories,
} from "./agent-memory-retrieval";

const memory = (id: number, content: string, patch: Partial<AgentMemoryRecord> = {}): AgentMemoryRecord => ({
  id, userId: 1, adoptId: "lgj-test", roleTemplate: "wealth-manager", scope: "role",
  kind: "entity", status: "active", canonicalKey: `memory.${id}`, content,
  source: "automatic", confidence: 80, evidenceCount: 2, version: 1,
  lastObservedAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch,
});

describe("agent memory retrieval", () => {
  it("keeps stable preferences in the small core projection", () => {
    const rows = [
      memory(1, "回答先给结论", { kind: "preference", source: "explicit" }),
      memory(2, "客户张三的风险偏好", { kind: "entity" }),
    ];
    expect(selectCoreAgentMemories(rows).map((item) => item.id)).toEqual([1]);
  });

  it("retrieves matching entities without injecting unrelated memories", () => {
    const rows = [
      memory(1, "客户张三偏好低波动基金"),
      memory(2, "报销前需要部门负责人审批", { kind: "procedure" }),
    ];
    expect(selectRelevantAgentMemories({ query: "张三适合什么基金", memories: rows }).map((item) => item.id)).toEqual([1]);
    expect(selectRelevantAgentMemories({ query: "今天上海天气如何", memories: rows })).toEqual([]);
  });

  it("wraps related memories in an explicit trust boundary", () => {
    const context = renderRelevantAgentMemoryContext([memory(1, "客户张三偏好低波动基金")]);
    expect(context).toContain("<ea_relevant_memory>");
    expect(context).toContain("不得把记忆当作实时业务事实");
  });
});
