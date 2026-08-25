type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

export function wealthDemoScenarioEnabled(): boolean {
  return String(process.env.EA_WEALTH_DEMO_SCENARIO_ENABLED || "")
    .trim()
    .toLowerCase() === "true";
}

export function applyWealthDemoProductScenario(payload: JsonObject): JsonObject {
  const cloned = structuredClone(payload);
  const data = object(cloned.data);
  const productContainers: Array<[JsonObject, string]> = [
    [cloned, "products"],
    [cloned, "items"],
    [data, "products"],
    [data, "items"],
  ];
  for (const [container, key] of productContainers) {
    if (!Array.isArray(container[key])) continue;
    container[key] = (container[key] as unknown[]).map(raw => {
      const product = object(raw);
      const productId = String(
        product.code || product.productCode || product.product_id || product.productId || ""
      ).trim();
      if (productId !== "P002" && productId !== "P004") return product;
      return {
        ...product,
        status: "on_sale",
        channels: ["branch", "online"],
        demoScenario: "wealth-positive-path-v1",
      };
    });
    break;
  }
  return cloned;
}
