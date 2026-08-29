import { describe, expect, it } from "vitest";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import { prepareWealthPrevisitContext } from "./wealth-previsit-context";

const principal = {
  tenantId: "tn_demo", organizationId: "org_demo", userId: 1, adoptionId: "lgj-demo",
  agentId: "agent-demo", roleTemplate: "wealth-manager", workspaceId: "/tmp/demo",
  permissionProfile: "plus", authorizationSnapshotId: "authz_demo",
  authorizationFingerprint: "a".repeat(64), sessionId: "session", identityVersion: "2",
} satisfies RuntimePrincipalV2;

describe("wealth previsit context", () => {
  it("binds authorized customer facts to eligible previsit knowledge", async () => {
    const result = await prepareWealthPrevisitContext({
      principal,
      customerId: "C-001",
      dependencies: {
        probeIdentity: async () => ({ allowed: true }),
        loadCustomer: async () => ({ customer: { customerId: "C-001", name: "演示客户", dataAsOf: "2026-08-13T00:00:00.000Z" } }),
        resolveKnowledge: async () => ({
          status: "ready", evaluatedAt: "2026-08-13T00:00:00.000Z",
          selected: { sourceAssetId: "wm-previsit-sop", documentId: "doc-1", versionLabel: "V1.0", contentHash: "b".repeat(64), sourceDepartment: "财富管理部" },
          eligibilityFingerprint: "c".repeat(64), userMessage: "已就绪",
        }),
      },
    });
    expect(result.status).toBe("ready");
    expect(result.evidence).toMatchObject({ customerId: "C-001", scopeVerified: true });
  });

  it("rejects a customer identity mismatch", async () => {
    await expect(prepareWealthPrevisitContext({
      principal,
      customerId: "C-001",
      dependencies: {
        probeIdentity: async () => ({ allowed: true }),
        loadCustomer: async () => ({ customer: { customerId: "C-OTHER" } }),
        resolveKnowledge: async () => ({ status: "unavailable", evaluatedAt: "", selected: null, eligibilityFingerprint: "", userMessage: "" }),
      },
    })).rejects.toThrow(/客户标识/);
  });

  it("accepts the governed wealth MCP customer number field", async () => {
    const result = await prepareWealthPrevisitContext({
      principal,
      customerId: "C001",
      dependencies: {
        probeIdentity: async () => ({ data: { verified: true } }),
        loadCustomer: async () => ({
          data: { customer: { CUST_NO: "C001", CUST_NAME: "演示客户" } },
          updatedAt: "2026-08-20T00:00:00.000Z",
        }),
        resolveKnowledge: async () => ({
          status: "ready", evaluatedAt: "2026-08-20T00:00:00.000Z",
          selected: { sourceAssetId: "wm-previsit-sop", documentId: "doc-1", versionLabel: "V1.0", contentHash: "b".repeat(64), sourceDepartment: "财富管理部" },
          eligibilityFingerprint: "c".repeat(64), userMessage: "已就绪",
        }),
      },
    });
    expect(result.status).toBe("ready");
    expect(result.evidence).toMatchObject({ customerId: "C001", scopeVerified: true });
  });

  it("assembles a governed shared profile with a separate wealth portfolio source", async () => {
    const result = await prepareWealthPrevisitContext({
      principal,
      customerId: "C005",
      dependencies: {
        probeIdentity: async () => ({ allowed: true }),
        loadCustomerProfile: async () => ({
          logicalContextId: "customer_profile",
          projectionId: "WealthCustomerProfileV1",
          projectionVersion: "1.0.0",
          purposeId: "wealth_advisory",
          status: "READY",
          sourceEvidence: [{ asOf: "2026-08-25T06:00:00.000Z" }],
          fields: [
            { path: "subject.subjectId", value: "C005" },
            { path: "subject.displayName", value: "陈明" },
            { path: "contact.maskedPhone", value: "138****8005" },
            { path: "risk.investmentRiskLevel", value: "C4" },
            { path: "risk.investmentRiskValidUntil", value: "2025-12-31T00:00:00.000Z" },
          ],
        }),
        loadCustomerPortfolio: async () => ({
          data: {
            customer: { CUST_NO: "C005", CUST_NAME: "陈明", CUST_PHONE_NO: "13800008005" },
            assetInfo: { total: 500_000 },
            heldProducts: [{ productId: "P003", balance: 160_217 }],
          },
          updatedAt: "2026-08-25T06:01:00.000Z",
        }),
        resolveKnowledge: async () => ({
          status: "ready", evaluatedAt: "2026-08-25T06:02:00.000Z",
          selected: { sourceAssetId: "wm-previsit-sop", documentId: "doc-1", versionLabel: "V1.0", contentHash: "b".repeat(64), sourceDepartment: "财富管理部" },
          eligibilityFingerprint: "c".repeat(64), userMessage: "已就绪",
        }),
      },
    });

    expect(result.status).toBe("ready");
    expect(result.customer).toMatchObject({
      customerId: "C005",
      name: "陈明",
      maskedPhone: "138****8005",
      riskLevel: "C4",
      portfolio: { heldProducts: [{ productId: "P003", balance: 160_217 }] },
    });
    expect(JSON.stringify(result.customer)).not.toContain("13800008005");
    expect(result.evidence).toMatchObject({
      profileDataAsOf: "2026-08-25T06:00:00.000Z",
      portfolioDataAsOf: "2026-08-25T06:01:00.000Z",
    });
    expect(result.evidence.profileResultFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.evidence.portfolioResultFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts a legacy source id only when governed profile and portfolio resolve to the same canonical customer", async () => {
    const result = await prepareWealthPrevisitContext({
      principal,
      customerId: "C005",
      dependencies: {
        probeIdentity: async () => ({ allowed: true }),
        loadCustomerProfile: async () => ({
          logicalContextId: "customer_profile",
          sourceEvidence: [{ asOf: "2026-08-25T06:00:00.000Z" }],
          fields: [
            { path: "subject.subjectId", value: "CUST-000005" },
            { path: "subject.displayName", value: "陈明" },
          ],
        }),
        loadCustomerPortfolio: async () => ({
          subjectId: "CUST-000005",
          summary: { totalAssets: 750_810 },
          sourceEvidence: [{ asOf: "2026-08-25T06:01:00.000Z" }],
        }),
        resolveKnowledge: async () => ({
          status: "ready", evaluatedAt: "2026-08-25T06:02:00.000Z",
          selected: { sourceAssetId: "wm-previsit-sop", documentId: "doc-1", versionLabel: "V1.0", contentHash: "b".repeat(64), sourceDepartment: "财富管理部" },
          eligibilityFingerprint: "c".repeat(64), userMessage: "已就绪",
        }),
      },
    });

    expect(result.customer).toMatchObject({ customerId: "CUST-000005", name: "陈明" });
    expect(result.evidence.customerId).toBe("CUST-000005");
  });

  it("rejects split governed sources that resolve a legacy id to different customers", async () => {
    await expect(prepareWealthPrevisitContext({
      principal,
      customerId: "C005",
      dependencies: {
        probeIdentity: async () => ({ allowed: true }),
        loadCustomerProfile: async () => ({
          logicalContextId: "customer_profile",
          fields: [{ path: "subject.subjectId", value: "CUST-000005" }],
        }),
        loadCustomerPortfolio: async () => ({ subjectId: "CUST-000006" }),
        resolveKnowledge: async () => ({
          status: "unavailable", evaluatedAt: "", selected: null,
          eligibilityFingerprint: "", userMessage: "",
        }),
      },
    })).rejects.toThrow(/同一客户标识/u);
  });
});
