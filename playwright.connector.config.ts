import "dotenv/config";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const appRoot = process.cwd();
const port = Number(process.env.EA_CONNECTOR_E2E_PORT || 5207);
const baseURL = process.env.EA_CONNECTOR_E2E_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["filesystem-connector.pw.ts", "object-storage-connector.pw.ts"],
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: process.env.EA_CONNECTOR_E2E_BASE_URL ? undefined : {
    command: "pnpm build && pnpm start",
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      PORT: String(port),
      APP_BIND_IP: "127.0.0.1",
      CORS_ORIGIN: baseURL,
      PUBLIC_BASE_URL: baseURL,
      ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS: path.join(appRoot, "data", "enterprise-connectors"),
      ENTERPRISE_OBJECT_STORAGE_ENDPOINTS: "http://127.0.0.1:5903",
      EA_CONNECTOR_E2E_OBS_ACCESS_KEY_ID: "test-access-key",
      EA_CONNECTOR_E2E_OBS_SECRET_ACCESS_KEY: "test-secret-key",
      ENTERPRISE_ASSET_STAGING_ROOT: path.join(appRoot, "data", "e2e-enterprise-asset-candidates"),
    },
  },
});
