import { describe, expect, it, vi } from "vitest";
import { EnterpriseMcpProvisioningCoordinator } from "./enterprise-mcp-provisioning-coordinator";

describe("EnterpriseMcpProvisioningCoordinator", () => {
  it("shares one provisioning operation across concurrent requests", async () => {
    let release: (() => void) | undefined;
    const provision = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const coordinator = new EnterpriseMcpProvisioningCoordinator(60_000);

    const first = coordinator.ensure("asset-a", provision);
    const second = coordinator.ensure("asset-a", provision);

    expect(provision).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);
  });

  it("retries after a failed operation", async () => {
    const provision = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    const coordinator = new EnterpriseMcpProvisioningCoordinator(60_000);

    await expect(coordinator.ensure("asset-a", provision)).rejects.toThrow("temporary failure");
    await expect(coordinator.ensure("asset-a", provision)).resolves.toBeUndefined();
    expect(provision).toHaveBeenCalledTimes(2);
  });

  it("provisions again after the successful entry expires", async () => {
    let now = 1_000;
    const provision = vi.fn().mockResolvedValue(undefined);
    const coordinator = new EnterpriseMcpProvisioningCoordinator(100, () => now);

    await coordinator.ensure("asset-a", provision);
    now = 1_050;
    await coordinator.ensure("asset-a", provision);
    now = 1_101;
    await coordinator.ensure("asset-a", provision);

    expect(provision).toHaveBeenCalledTimes(2);
  });

  it("does not share provisioning across different asset fingerprints", async () => {
    const provision = vi.fn().mockResolvedValue(undefined);
    const coordinator = new EnterpriseMcpProvisioningCoordinator(60_000);

    await Promise.all([
      coordinator.ensure("asset-a", provision),
      coordinator.ensure("asset-b", provision),
    ]);

    expect(provision).toHaveBeenCalledTimes(2);
  });
});

