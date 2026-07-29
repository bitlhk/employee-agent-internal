import { describe, expect, it } from "vitest";
import {
  monitoringConfig,
  readMonitoringStatus,
  resolveLoopbackMonitoringUrl,
} from "./monitoring-routes";

describe("monitoring configuration", () => {
  it("accepts only loopback HTTP service URLs", () => {
    expect(
      resolveLoopbackMonitoringUrl(
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3000"
      )?.origin
    ).toBe("http://127.0.0.1:3000");
    expect(
      resolveLoopbackMonitoringUrl("http://[::1]:3000", "http://127.0.0.1:3000")
        ?.origin
    ).toBe("http://[::1]:3000");
    expect(
      resolveLoopbackMonitoringUrl(
        "https://127.0.0.1:3000",
        "http://127.0.0.1:3000"
      )
    ).toBeNull();
    expect(
      resolveLoopbackMonitoringUrl(
        "http://10.0.0.8:3000",
        "http://127.0.0.1:3000"
      )
    ).toBeNull();
    expect(
      resolveLoopbackMonitoringUrl(
        "http://localhost:3000",
        "http://127.0.0.1:3000"
      )
    ).toBeNull();
    expect(
      resolveLoopbackMonitoringUrl(
        "http://127.0.0.1:3000/api",
        "http://127.0.0.1:3000"
      )
    ).toBeNull();
  });

  it("keeps monitoring disabled unless explicitly enabled", () => {
    expect(monitoringConfig({}).configured).toBe(false);
    expect(monitoringConfig({ EA_MONITORING_ENABLED: "true" }).configured).toBe(
      true
    );
    expect(
      monitoringConfig({ EA_MONITORING_ENABLED: "1" }).dashboardUrl
    ).toContain("/ops/grafana/d/employee-agent-overview/");
  });

  it("returns a stable disabled status without network checks", async () => {
    const status = await readMonitoringStatus({});
    expect(status.configured).toBe(false);
    expect(status.available).toBe(false);
    expect(status.dashboardUrl).toBeNull();
    expect(status.services.grafana.detail).toBe("未启用");
  });

  it("fails closed when an enabled target is not loopback", async () => {
    const status = await readMonitoringStatus({
      EA_MONITORING_ENABLED: "true",
      GRAFANA_INTERNAL_URL: "http://169.254.169.254",
      PROMETHEUS_URL: "http://127.0.0.1:9090",
    });
    expect(status.configured).toBe(true);
    expect(status.available).toBe(false);
    expect(status.dashboardUrl).toBeNull();
    expect(status.services.grafana.detail).toBe("配置无效");
  });
});
