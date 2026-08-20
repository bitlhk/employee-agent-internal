import { describe, expect, it } from "vitest";
import { wealthContextNeedPlans } from "./wealth-context-plans";

describe("wealth ContextNeedPlan V1", () => {
  it("defines exactly the four controlled Golden Tasks", () => {
    expect(Array.from(wealthContextNeedPlans().keys())).toEqual(["WM-GT-01", "WM-GT-02", "WM-GT-03", "WM-GT-05"]);
  });

  it("keeps executable policy, Skill and Capability outside fact Context types", () => {
    for (const plan of wealthContextNeedPlans().values()) {
      expect(plan.needs.every((need) => ["knowledge", "business_data", "memory"].includes(need.contextType))).toBe(true);
    }
  });

  it("marks current policy as required for policy and allocation tasks", () => {
    for (const taskId of ["WM-GT-02", "WM-GT-03"]) {
      expect(wealthContextNeedPlans().get(taskId)?.needs).toContainEqual(expect.objectContaining({
        logicalAssetId: "current_wealth_policy",
        requiredness: "required",
      }));
    }
  });
});
