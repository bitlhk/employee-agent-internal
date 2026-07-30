import { defineConfig } from "vitest/config";
import path from "path";

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
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts", "client/src/**/*.test.ts", "client/src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      include: ["server/**/*.ts", "client/src/**/*.{ts,tsx}", "shared/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        statements: 21,
        branches: 65,
        functions: 41,
        lines: 21,
      },
    },
  },
});
