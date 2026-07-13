import { describe, expect, it } from "vitest";
import { isDynamicImportError } from "./ErrorBoundary";

describe("isDynamicImportError", () => {
  it("recognizes browser and bundler chunk load failures", () => {
    expect(isDynamicImportError(new TypeError("Failed to fetch dynamically imported module: /assets/Home.js"))).toBe(true);
    expect(isDynamicImportError(Object.assign(new Error("Loading chunk 42 failed"), { name: "ChunkLoadError" }))).toBe(true);
  });

  it("does not classify ordinary render failures as chunk failures", () => {
    expect(isDynamicImportError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
});
