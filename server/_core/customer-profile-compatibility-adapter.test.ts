import { describe, expect, it, vi } from "vitest";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import {
  loadInsuranceCustomerProfileCompatibilitySource,
  type CustomerProfileEnterpriseSourceCallerV1,
} from "./customer-profile-compatibility-adapter";
import { projectCustomerProfile } from "./customer-profile-provider";
import { principalFingerprint } from "./governance/contracts";

const principal: RuntimePrincipalV2 = {
  userId: 22,
  adoptionId: "lgj-insurance-demo",
  agentId: "jiuwen_lgj-insurance-demo",
  roleTemplate: "insurance-advisor",
  workspaceId: "/tmp/insurance-demo",
  permissionProfile: "insurance-default",
  sessionId: "insurance-session",
  taskId: "IA-GT-01",
  tenantId: "tenant-demo",
  organizationId: "organization-demo",
  authorizationSnapshotId: "authorization-snapshot-demo",
  authorizationFingerprint: "authorization-fingerprint-demo",
  identityVersion: "2",
};

function mcpResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  };
}

function caller(
  detailOverrides: Record<string, unknown> = {}
): ReturnType<typeof vi.fn<CustomerProfileEnterpriseSourceCallerV1>> {
  return vi.fn<CustomerProfileEnterpriseSourceCallerV1>(async input => {
    if (input.toolName === "list_customer_profiles")
      return mcpResult({
        total: 2,
        items: [
          { id: 1, name: "李国栋" },
          { id: 2, name: "王慧兰" },
        ],
      });
    return mcpResult({
      id: 1,
      name: "李国栋",
      customer_status: "renewal_due",
      age: 48,
      occupation: "business_owner",
      city: "苏州",
      risk_preference: "service_first",
      contact_strategy: "appointment_only",
      vehicle_info: "沪A12345 VIN:LSV12345678901234",
      annual_mileage: "15000 km",
      driving_record: "no material claims",
      protection_gap: "medical, accident",
      bio: "raw biography must not pass",
      ...detailOverrides,
    });
  });
}

describe("Customer Profile compatibility adapter", () => {
  it("binds a legacy name lookup to the stable id returned by Enterprise MCP", async () => {
    const callEnterpriseTool = caller();
    const loaded = await loadInsuranceCustomerProfileCompatibilitySource({
      principal,
      subjectId: "1",
      callEnterpriseTool,
    });

    expect(callEnterpriseTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        serverId: "insurance_customer_profile",
        toolName: "list_customer_profiles",
      })
    );
    expect(callEnterpriseTool).toHaveBeenNthCalledWith(2, {
      serverId: "insurance_customer_profile",
      toolName: "get_customer_profile_by_name",
      args: { name: "李国栋" },
    });
    expect(loaded).toMatchObject({
      principalAuthorized: true,
      subjectInScope: true,
      sources: [
        {
          sourceContractId: "insurance-customer-profile-demo-v1",
          sourceSystem: "insurance_customer_profile",
          subjectId: "1",
          productionReady: false,
        },
      ],
    });
    const serialized = JSON.stringify(loaded.sources[0]);
    expect(serialized).not.toContain("raw biography must not pass");
    expect(serialized).not.toContain("沪A12345");
    expect(loaded.sources[0]?.fields.map(field => field.path)).toEqual(
      expect.arrayContaining([
        "subject.subjectId",
        "subject.customerStatus",
        "insurance.vehicleSummary",
        "insurance.protectionGaps",
      ])
    );
  });

  it("adds only the missing synthetic Demo facts when explicitly enabled", async () => {
    const loaded = await loadInsuranceCustomerProfileCompatibilitySource({
      principal,
      subjectId: "1",
      callEnterpriseTool: caller(),
      includeDemoFacts: true,
    });

    expect(loaded.sources).toHaveLength(2);
    expect(loaded.sources.map(source => source.sourceSystem)).toEqual([
      "insurance_customer_profile",
      "grace_demo_insurance_facts",
    ]);
    expect(
      loaded.sources.every(source => source.assuranceLevel === "demo")
    ).toBe(true);
    expect(loaded.sources[1]?.fields.map(field => field.path).sort()).toEqual([
      "insurance.claimsRiskSummary",
      "insurance.currentCoverageSummary",
      "insurance.renewalAt",
      "insurance.renewalStatus",
      "serviceScope.inScope",
    ]);

    const projection = projectCustomerProfile({
      roleTemplate: "insurance-advisor",
      taskId: "IA-GT-01",
      requestedSubjectId: "1",
      principalFingerprint: principalFingerprint(principal),
      principalAuthorized: loaded.principalAuthorized,
      subjectInScope: loaded.subjectInScope,
      sources: loaded.sources,
      requiredAssuranceLevel: "demo",
    });
    expect(projection.status).toBe("DEGRADED");
    expect(projection.reasonCodes).toEqual([
      "CUSTOMER_PROFILE_OPTIONAL_FIELD_MISSING",
    ]);
    expect(
      projection.fields.find(field => field.path === "insurance.vehicleSummary")
        ?.provenance.sourceSystem
    ).toBe("insurance_customer_profile");
    expect(
      projection.fields.find(field => field.path === "insurance.renewalStatus")
        ?.provenance.sourceSystem
    ).toBe("grace_demo_insurance_facts");
    expect(
      projection.fields.some(field => field.path.startsWith("wealth."))
    ).toBe(false);
  });

  it("does not use a display name as identity proof", async () => {
    const callEnterpriseTool = caller();
    const loaded = await loadInsuranceCustomerProfileCompatibilitySource({
      principal,
      subjectId: "999",
      callEnterpriseTool,
    });
    expect(loaded.sources).toEqual([]);
    expect(loaded.subjectInScope).toBe(false);
    expect(callEnterpriseTool).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the legacy detail response returns another id", async () => {
    await expect(
      loadInsuranceCustomerProfileCompatibilitySource({
        principal,
        subjectId: "1",
        callEnterpriseTool: caller({ id: 2 }),
      })
    ).rejects.toThrow("CUSTOMER_PROFILE_SOURCE_SUBJECT_MISMATCH");
  });

  it("fails closed when Enterprise MCP denies the source call", async () => {
    const callEnterpriseTool = vi.fn<CustomerProfileEnterpriseSourceCallerV1>(
      async () => ({
        isError: true,
        content: [{ type: "text", text: "该客户不属于当前岗位范围" }],
      })
    );
    await expect(
      loadInsuranceCustomerProfileCompatibilitySource({
        principal,
        subjectId: "1",
        callEnterpriseTool,
      })
    ).rejects.toThrow("CUSTOMER_PROFILE_UPSTREAM_DENIED");
  });
});
