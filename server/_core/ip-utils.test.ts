import { describe, expect, it } from "vitest";
import { resolveTrustProxySetting } from "./ip-utils";

describe("trust proxy configuration", () => {
  it("parses production booleans, hop counts and explicit proxy addresses", () => {
    expect(resolveTrustProxySetting(undefined, "production")).toBe(false);
    expect(resolveTrustProxySetting("true", "production")).toBe(true);
    expect(resolveTrustProxySetting("1", "production")).toBe(1);
    expect(resolveTrustProxySetting("10.0.0.1, 10.0.0.2", "production")).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("trusts the local development proxy regardless of production settings", () => {
    expect(resolveTrustProxySetting(undefined, "development")).toBe(true);
  });
});
