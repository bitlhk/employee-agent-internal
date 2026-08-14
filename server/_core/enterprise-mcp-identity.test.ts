import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, exportJWK, importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  enterpriseMcpIdentityStatus,
  enterpriseMcpJwks,
  enterpriseMcpTenantId,
  issueEnterpriseMcpAccessToken,
  resetEnterpriseMcpIdentityForTests,
} from "./enterprise-mcp-identity";

const previous = { ...process.env };

afterEach(() => {
  process.env = { ...previous };
  resetEnterpriseMcpIdentityForTests();
});

function configureIdentity() {
  const pair = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  process.env.ENTERPRISE_MCP_PRIVATE_KEY_PEM = pair.privateKey;
  process.env.ENTERPRISE_MCP_PUBLIC_KEY_PEM = pair.publicKey;
  process.env.ENTERPRISE_MCP_IDENTITY_ISSUER = "https://work.example.com";
  process.env.ENTERPRISE_MCP_KEY_ID = "test-key";
  process.env.ENTERPRISE_MCP_TOKEN_TTL_SECONDS = "120";
  resetEnterpriseMcpIdentityForTests();
  return pair;
}

describe("enterprise MCP workload identity", () => {
  it("reports an unavailable provider without a signing key", async () => {
    delete process.env.ENTERPRISE_MCP_PRIVATE_KEY_PEM;
    delete process.env.ENTERPRISE_MCP_PRIVATE_KEY_FILE;
    resetEnterpriseMcpIdentityForTests();
    await expect(enterpriseMcpIdentityStatus()).resolves.toMatchObject({ configured: false });
  });

  it("creates stable opaque tenant ids", () => {
    process.env.EA_TENANCY_MODE = "legacy";
    expect(enterpriseMcpTenantId("Example Bank", 1)).toBe(enterpriseMcpTenantId(" example bank ", 9));
    expect(enterpriseMcpTenantId(null, 1)).not.toBe(enterpriseMcpTenantId(null, 2));
  });

  it("uses the configured Linggan Finance tenant in demo mode", () => {
    process.env.EA_TENANCY_MODE = "demo_single_org";
    process.env.EA_DEMO_TENANT_ID = "tn_linggan_finance";
    expect(enterpriseMcpTenantId("Company A", 1)).toBe("tn_linggan_finance");
    expect(enterpriseMcpTenantId("Company B", 2)).toBe("tn_linggan_finance");
  });

  it("issues a short lived ES256 token verifiable by JWKS", async () => {
    configureIdentity();
    const issued = await issueEnterpriseMcpAccessToken({
      caller: { userId: 7, organization: "Example Bank", adoptId: "lgj-demo", agentId: "agent-demo", roleKey: "insurance-advisor" },
      identityMode: "user",
      resourceUri: "https://mcp.demo.example/insurance/customer/mcp",
      serverId: "insurance_customer_profile",
      toolName: "list_customer_profiles",
      scopes: ["insurance.customer.read"],
      requestId: "mcp_req_test",
    });
    expect(decodeProtectedHeader(issued.token)).toMatchObject({ alg: "ES256", kid: "test-key", typ: "at+jwt" });
    const jwks = await enterpriseMcpJwks();
    const key = await importJWK(jwks.keys[0], "ES256");
    const verified = await jwtVerify(issued.token, key, {
      issuer: "https://work.example.com",
      audience: "https://mcp.demo.example/insurance/customer/mcp",
    });
    expect(verified.payload).toMatchObject({
      sub: "ea-user:7",
      user_id: 7,
      actor_user_id: 7,
      role: "insurance-advisor",
      scope: "insurance.customer.read",
      request_id: "mcp_req_test",
    });
    expect(typeof verified.payload.nbf).toBe("number");
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBe(120);
  });

  it("publishes active and previous public keys while signing only with the active key", async () => {
    configureIdentity();
    const previousPair = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const previousJwk = await exportJWK(createPublicKey(previousPair.publicKey));
    process.env.ENTERPRISE_MCP_ADDITIONAL_JWKS_JSON = JSON.stringify({
      keys: [{ ...previousJwk, kid: "previous-key", alg: "ES256", use: "sig" }],
    });
    resetEnterpriseMcpIdentityForTests();

    const status = await enterpriseMcpIdentityStatus();
    expect(status).toMatchObject({ keyId: "test-key", keyCount: 2 });
    expect(status.keyIds).toEqual(["test-key", "previous-key"]);
    const jwks = await enterpriseMcpJwks();
    expect(jwks.keys.map(key => key.kid)).toEqual(["test-key", "previous-key"]);

    const issued = await issueEnterpriseMcpAccessToken({
      caller: { userId: 7, organization: "Example Bank", adoptId: "lgj-demo", agentId: "agent-demo", roleKey: "insurance-advisor" },
      identityMode: "tenant",
      resourceUri: "https://mcp.demo.example/insurance/product/mcp",
      serverId: "insurance_product_exam_points",
      toolName: "list_products",
      scopes: ["insurance.product.read"],
      requestId: "mcp_req_rotation",
    });
    expect(decodeProtectedHeader(issued.token).kid).toBe("test-key");
  });

  it("rejects a conflicting public key that reuses the active kid", async () => {
    configureIdentity();
    const conflictingPair = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const conflictingJwk = await exportJWK(createPublicKey(conflictingPair.publicKey));
    process.env.ENTERPRISE_MCP_ADDITIONAL_JWKS_JSON = JSON.stringify({
      keys: [{ ...conflictingJwk, kid: "test-key", alg: "ES256", use: "sig" }],
    });
    resetEnterpriseMcpIdentityForTests();
    await expect(enterpriseMcpJwks()).rejects.toThrow(/conflicting kid/);
  });
});
