import path from "path";
import { defineConfig } from "vitest/config";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    // Integration-style route tests import the full server graph; instrumented
    // cold imports on Windows can exceed Vitest's five-second default.
    testTimeout: 15000,
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      "client/src/**/*.test.ts",
      "client/src/**/*.spec.ts",
      "shared/**/*.test.ts",
      "shared/**/*.spec.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["server/**/*.ts", "client/src/**/*.{ts,tsx}", "shared/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        statements: 22,
        branches: 65,
        functions: 43,
        lines: 22,
      },
    },
  },
});
