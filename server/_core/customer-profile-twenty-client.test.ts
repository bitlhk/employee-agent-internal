import { describe, expect, it, vi } from "vitest";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import {
  createTwentyCustomerProfileRecordLoaderV1,
  TwentyCustomerCrmClientV1,
} from "./customer-profile-twenty-client";

const principal: RuntimePrincipalV2 = {
  userId: 1,
  adoptionId: "insurance-adoption",
  agentId: "insurance-agent",
  roleTemplate: "insurance-advisor",
  workspaceId: "workspace",
  permissionProfile: "insurance-advisor",
  sessionId: "session",
  tenantId: "tn_demo",
  organizationId: "org-demo",
  authorizationSnapshotId: "snapshot",
  authorizationFingerprint: "authorization",
  identityVersion: "2",
};

function response(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Twenty Customer CRM client", () => {
  it("loads one explicitly scoped profile without reading suggestions", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          data: {
            graceCustomers: [
              {
                name: "测试客户",
                graceCustomerId: "DEMO-INS-TN_DEMO-1",
                customerStatus: "active",
                tenantId: "tn_demo",
                ownerUserId: "101",
                businessAsOf: "2026-08-27T00:00:00.000Z",
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        response({
          data: {
            customerDomainProfiles: [
              {
                graceCustomerId: "DEMO-INS-TN_DEMO-1",
                profileType: "auto_insurance",
                detailSchemaVersion: "auto-insurance.v1",
                demographics: { age: 40 },
                preferences: {},
                insuranceFacts: {},
                detail: { annualMileage: "约1万公里" },
                fieldProvenance: {},
              },
              {
                graceCustomerId: "DEMO-INS-TN_DEMO-1",
                profileType: "wealth",
                detailSchemaVersion: "wealth.v1",
              },
            ],
          },
        })
      );
    const client = new TwentyCustomerCrmClientV1({
      baseUrl: "http://127.0.0.1:19030",
      apiKey: "test-key",
      request,
    });
    const record = await client.loadCustomerProfile({
      graceCustomerId: "DEMO-INS-TN_DEMO-1",
      allowedProfileTypes: ["auto_insurance", "life_insurance"],
    });
    expect(record?.profileType).toBe("auto_insurance");
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.map(call => String(call[0])).join(" ")
    ).not.toContain("customerSuggestions");
  });

  it("authorizes before retrieving customer records", async () => {
    const request = vi.fn<typeof fetch>();
    const loader = createTwentyCustomerProfileRecordLoaderV1({
      client: new TwentyCustomerCrmClientV1({
        baseUrl: "http://127.0.0.1:19030",
        apiKey: "test-key",
        request,
      }),
      authorize: async () => ({
        allowed: false,
        subjectInScope: false,
        authorizationEvidenceId: "deny-evidence",
        allowedProfileTypes: [],
      }),
    });
    await expect(
      loader({ graceCustomerId: "DEMO-INS-TN_DEMO-1", principal })
    ).resolves.toMatchObject({
      record: null,
      principalAuthorized: false,
      subjectInScope: false,
      authorizationEvidenceId: "deny-evidence",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects insecure non-loopback endpoints", () => {
    expect(
      () =>
        new TwentyCustomerCrmClientV1({
          baseUrl: "http://crm.example.internal:3000",
          apiKey: "test-key",
        })
    ).toThrow("TWENTY_CUSTOMER_CRM_HTTPS_REQUIRED");
  });

  it("writes only governed interaction and task records through idempotent upsert", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ data: {} }));
    const client = new TwentyCustomerCrmClientV1({
      baseUrl: "http://127.0.0.1:19030",
      apiKey: "test-key",
      request,
    });
    await client.writeConfirmedInteraction({
      interactionKey: "visit-1",
      graceCustomerId: "DEMO-INS-TN_DEMO-1",
      interactionType: "visit",
      happenedAt: "2026-08-27T10:00:00.000Z",
      summary: "客户确认续保需求",
      purposeId: "insurance_advisory",
      organizationId: "org-1",
      confirmedBy: "user-1",
      confirmedAt: "2026-08-27T10:05:00.000Z",
      executionReceiptId: "wex-1",
      provenance: {},
    });
    await client.writeFollowupTask({
      taskKey: "governed-work:org-1:wi-1",
      graceCustomerId: "DEMO-INS-TN_DEMO-1",
      workItemId: "wi-1",
      subject: "准备续保方案",
      description: null,
      taskStatus: "open",
      dueAt: null,
      ownerPrincipalId: "user-1",
      ownerDisplayName: "保险顾问",
      purposeId: "insurance_advisory",
      organizationId: "org-1",
      confirmedBy: "user-1",
      confirmedAt: "2026-08-27T10:05:00.000Z",
      executionReceiptId: "wex-1",
      lastIdempotencyKey: "confirm-wi-1",
      workStateUpdatedAt: "2026-08-27T10:05:00.000Z",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0]?.[0])).toContain(
      "/rest/batch/customerInteractions?upsert=true"
    );
    expect(String(request.mock.calls[1]?.[0])).toContain(
      "/rest/batch/customerFollowupTasks?upsert=true"
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });
});
