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
});
