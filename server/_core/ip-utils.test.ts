import { describe, expect, it } from "vitest";
import { normalizeIp, resolveTrustProxySetting } from "./ip-utils";

describe("IP normalization", () => {
  it("normalizes loopback and IPv4-mapped IPv6 addresses", () => {
    expect(normalizeIp("[::1]")).toBe("127.0.0.1");
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(normalizeIp("0:0:0:0:0:ffff:0a00:1")).toBe("10.0.0.1");
    expect(normalizeIp("::ffff:808:808")).toBe("8.8.8.8");
  });

  it("canonicalizes regular IPv6 addresses and preserves IPv4", () => {
    expect(normalizeIp("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(normalizeIp("203.0.113.8")).toBe("203.0.113.8");
  });
});

describe("trust proxy configuration", () => {
  it("parses production booleans, hop counts and explicit proxy addresses", () => {
    expect(resolveTrustProxySetting(undefined, "production")).toBe(false);
    expect(resolveTrustProxySetting("true", "production")).toBe(true);
    expect(resolveTrustProxySetting("1", "production")).toBe(1);
    expect(
      resolveTrustProxySetting("10.0.0.1, 10.0.0.2", "production")
    ).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("trusts the local development proxy regardless of production settings", () => {
    expect(resolveTrustProxySetting(undefined, "development")).toBe(true);
  });
});
