import { describe, expect, it } from "vitest";
import { resolveAppBindIp } from "./network-bind";

describe("application bind address", () => {
  it("defaults to loopback and accepts explicit addresses", () => {
    expect(resolveAppBindIp("")).toBe("127.0.0.1");
    expect(resolveAppBindIp("localhost")).toBe("127.0.0.1");
    expect(resolveAppBindIp("0.0.0.0")).toBe("0.0.0.0");
    expect(resolveAppBindIp("::1")).toBe("::1");
  });

  it("rejects hostnames and malformed values", () => {
    expect(() => resolveAppBindIp("example.com")).toThrow(/valid IPv4 or IPv6/);
  });
});
