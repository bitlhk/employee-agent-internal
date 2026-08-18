import { describe, expect, it } from "vitest";
import { selectRoleHomeTaskIds } from "../../shared/role-experience";
import type { Skill } from "../../shared/types/skill";
import { buildRoleHomeRuntimeStatus } from "./role-home-runtime";

function readySkill(id = "wealth-manager-assistant"): Skill {
  return {
    id,
    adoptId: "lgj-test",
    source: { kind: "role_default", skillId: id, displayName: id },
    state: "ready",
    enabled: true,
    review: { state: "none" },
    sync: {},
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

describe("role home runtime projection", () => {
  it("uses the governed follow-up task when its write capability is ready", () => {
    const status = buildRoleHomeRuntimeStatus({
      roleTemplate: "wealth-manager",
      connectors: [
        { serverId: "wealth_assistant_customer", status: "READY" },
        { serverId: "wealth_assistant_product", status: "READY" },
        { serverId: "wealth_governance_demo", status: "READY" },
      ],
      knowledgeReady: true,
      skills: [readySkill()],
    });

    expect(status.tasks.every((task) => task.status === "READY")).toBe(true);
    expect(selectRoleHomeTaskIds("wealth-manager", status.tasks)).toEqual([
      "WM-GT-01",
      "WM-GT-02",
      "WM-GT-06",
      "WM-GT-05",
    ]);
    expect(status.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "customer-operations", status: "READY", statusLabel: "已就绪" }),
      expect.objectContaining({ id: "compliance-guard", status: "READY", statusLabel: "已就绪" }),
    ]));
  });

  it("keeps safe operations available when the write connector is not provisioned", () => {
    const status = buildRoleHomeRuntimeStatus({
      roleTemplate: "wealth-manager",
      connectors: [
        { serverId: "wealth_assistant_customer", status: "READY" },
        { serverId: "wealth_assistant_product", status: "READY" },
      ],
      knowledgeReady: true,
      skills: [readySkill()],
    });

    expect(status.tasks.find((task) => task.taskId === "WM-GT-05")?.status).toBe("BLOCKED");
    expect(status.tasks.find((task) => task.taskId === "WM-GT-06")?.status).toBe("READY");
    expect(selectRoleHomeTaskIds("wealth-manager", status.tasks)).toEqual([
      "WM-GT-01", "WM-GT-02", "WM-GT-06", "WM-GT-05",
    ]);
    expect(status.capabilities.find((item) => item.id === "customer-operations")?.status).toBe("DEGRADED");
  });

  it("blocks policy verification without current role knowledge and degrades safe fallback tasks", () => {
    const status = buildRoleHomeRuntimeStatus({
      roleTemplate: "wealth-manager",
      connectors: [
        { serverId: "wealth_assistant_customer", status: "READY" },
        { serverId: "wealth_assistant_product", status: "READY" },
      ],
      knowledgeReady: false,
      skills: [readySkill()],
    });

    expect(status.tasks.find((task) => task.taskId === "WM-GT-03")?.status).toBe("BLOCKED");
    expect(status.tasks.find((task) => task.taskId === "WM-GT-01")?.status).toBe("DEGRADED");
    expect(status.capabilities.find((item) => item.id === "compliance-guard")).toMatchObject({
      status: "DEGRADED",
      statusLabel: "有限可用",
    });
  });

  it("projects the same task and capability protocol for another reference role", () => {
    const status = buildRoleHomeRuntimeStatus({
      roleTemplate: "insurance-advisor",
      connectors: [
        { serverId: "insurance_customer_profile", status: "READY" },
        { serverId: "insurance_product_exam_points", status: "DEGRADED" },
      ],
      knowledgeReady: true,
      skills: [readySkill("auto-insurance-advisor")],
    });

    expect(status.tasks.find((task) => task.taskId === "IA-GT-01")?.status).toBe("READY");
    expect(status.tasks.find((task) => task.taskId === "IA-GT-02")?.status).toBe("DEGRADED");
    expect(status.capabilities.find((item) => item.id === "product-explanation")?.status).toBe("DEGRADED");
  });

  it("projects smart-audit Golden Tasks from real knowledge, skill and connector readiness", () => {
    const status = buildRoleHomeRuntimeStatus({
      roleTemplate: "credential-compliance",
      connectors: [
        { serverId: "credential_image_workspace", status: "READY" },
        { serverId: "wealth_governance_demo", status: "READY" },
      ],
      knowledgeReady: true,
      skills: [readySkill("smart-audit-assistant")],
    });
    expect(status.tasks).toHaveLength(6);
    expect(status.tasks.every((task) => task.status === "READY")).toBe(true);
    expect(selectRoleHomeTaskIds("credential-compliance", status.tasks)).toEqual([
      "AU-GT-01", "AU-GT-02", "AU-GT-03", "AU-GT-06",
    ]);
    expect(status.capabilities.find((item) => item.id === "human-review")?.status).toBe("READY");
  });

  it("projects investment research tasks from Wind and governed write readiness", () => {
    const status = buildRoleHomeRuntimeStatus({
      roleTemplate: "investment-researcher",
      connectors: [
        { serverId: "wind_stock_data", status: "READY" },
        { serverId: "wind_financial_docs", status: "READY" },
        { serverId: "wind_analytics_data", status: "READY" },
        { serverId: "wealth_governance_demo", status: "READY" },
      ],
      knowledgeReady: true,
      skills: [readySkill("investment-research-assistant")],
    });
    expect(status.tasks).toHaveLength(6);
    expect(status.tasks.every((task) => task.status === "READY")).toBe(true);
    expect(selectRoleHomeTaskIds("investment-researcher", status.tasks)).toEqual([
      "IR-GT-01", "IR-GT-02", "IR-GT-05", "IR-GT-06",
    ]);
    expect(status.capabilities.find((item) => item.id === "event-tracking")?.status).toBe("READY");
  });
});
