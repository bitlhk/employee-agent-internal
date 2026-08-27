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
            enterpriseCustomers: [
              {
                name: "测试客户",
                globalCustomerId: "DEMO-INS-TN_DEMO-1",
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
                globalCustomerId: "DEMO-INS-TN_DEMO-1",
                profileType: "auto_insurance",
                detailSchemaVersion: "auto-insurance.v1",
                runtimeStatus: "active",
                demographics: { age: 40 },
                preferences: {},
                insuranceFacts: {},
                detail: { annualMileage: "约1万公里" },
                fieldProvenance: {},
              },
              {
                globalCustomerId: "DEMO-INS-TN_DEMO-1",
                profileType: "wealth",
                detailSchemaVersion: "wealth.v1",
                runtimeStatus: "active",
              },
              {
                globalCustomerId: "DEMO-INS-TN_DEMO-1",
                profileType: "life_insurance",
                detailSchemaVersion: "life-insurance.v1",
                runtimeStatus: "active",
                demographics: { age: 40 },
                preferences: {},
                insuranceFacts: {},
                detail: { familyStructure: "已婚" },
                fieldProvenance: {},
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
      globalCustomerId: "DEMO-INS-TN_DEMO-1",
      allowedProfileTypes: ["auto_insurance", "life_insurance"],
    });
    expect(record?.profiles.map(profile => profile.profileType)).toEqual([
      "auto_insurance",
      "life_insurance",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    const requests = request.mock.calls.map(call => String(call[0])).join(" ");
    expect(requests).not.toContain("customerSuggestions");
    expect(requests).toContain("profileType%5Beq%5D%3A%22auto_insurance%22");
    expect(requests).toContain("profileType%5Beq%5D%3A%22life_insurance%22");
    expect(requests).not.toContain("profileType%5Beq%5D%3A%22wealth%22");
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
      loader({ globalCustomerId: "DEMO-INS-TN_DEMO-1", principal })
    ).resolves.toMatchObject({
      record: null,
      principalAuthorized: false,
      subjectInScope: false,
      authorizationEvidenceId: "deny-evidence",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves legacy source IDs without exposing source-specific tools", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          customerSourceLinks: [
            {
              sourceSystem: "wealth_assistant_customer",
              sourceCustomerId: "C005",
              globalCustomerId: "CUST-000005",
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
    await expect(
      client.resolveGlobalCustomerId({
        customerId: "C005",
        allowedSourceSystems: ["wealth_assistant_customer"],
      })
    ).resolves.toBe("CUST-000005");
  });

  it("does not provide candidate profiles through the production default", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          data: {
            enterpriseCustomers: [
              {
                name: "测试客户",
                globalCustomerId: "CUST-000101",
                customerStatus: "active",
                visibilityScope: "demo_public",
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
                globalCustomerId: "CUST-000101",
                profileType: "auto_insurance",
                detailSchemaVersion: "auto-insurance.v1",
                runtimeStatus: "candidate",
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
    await expect(
      client.loadCustomerProfile({
        globalCustomerId: "CUST-000101",
        allowedProfileTypes: ["auto_insurance"],
      })
    ).rejects.toThrow("TWENTY_CUSTOMER_CRM_PROFILE_NOT_ELIGIBLE");
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
      globalCustomerId: "DEMO-INS-TN_DEMO-1",
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
      globalCustomerId: "DEMO-INS-TN_DEMO-1",
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
