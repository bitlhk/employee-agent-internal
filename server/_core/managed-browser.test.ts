import { describe, expect, it } from "vitest";
import { isPrivateManagedBrowserIp } from "./managed-browser";

describe("managed browser IP policy", () => {
  it("blocks local, metadata, documentation, and IPv4-mapped addresses", () => {
    for (const address of [
      "127.0.0.1", "10.0.0.1", "169.254.169.254", "100.100.100.200",
      "192.0.2.10", "198.51.100.10", "203.0.113.10", "::1", "fc00::1",
      "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:0a00:1",
      "::ffff:c0a8:1", "0:0:0:0:0:ffff:7f00:1",
    ]) expect(isPrivateManagedBrowserIp(address), address).toBe(true);
  });

  it("allows public addresses", () => {
    expect(isPrivateManagedBrowserIp("8.8.8.8")).toBe(false);
    expect(isPrivateManagedBrowserIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateManagedBrowserIp("::ffff:808:808")).toBe(false);
  });
});
