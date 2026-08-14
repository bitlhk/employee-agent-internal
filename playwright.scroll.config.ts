import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: process.env.EA_E2E_BASE_URL || "https://work.linggan.top",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
});
