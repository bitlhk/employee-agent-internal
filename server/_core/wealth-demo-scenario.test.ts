import { describe, expect, it } from "vitest";
import { applyWealthDemoProductScenario } from "./wealth-demo-scenario";

describe("Wealth positive-path Demo product facts", () => {
  it("activates only the two governed C005 candidate products", () => {
    const result = applyWealthDemoProductScenario({
      data: {
        products: [
          { code: "P002", status: "inactive" },
          { code: "P003", status: "inactive" },
          { code: "P004", status: "inactive" },
        ],
      },
    });
    const data = result.data as Record<string, unknown>;
    expect(data.products).toEqual([
      expect.objectContaining({ code: "P002", status: "on_sale", demoScenario: "wealth-positive-path-v1" }),
      { code: "P003", status: "inactive" },
      expect.objectContaining({ code: "P004", status: "on_sale", demoScenario: "wealth-positive-path-v1" }),
    ]);
  });
});
