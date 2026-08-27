import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import {
  evaluateTwentyCustomerAccess,
  listAuthorizedTwentyCustomers,
} from "./customer-context-twenty-access";
import type {
  TwentyCustomerAssignmentV1,
  TwentyCustomerSummaryV1,
} from "./customer-profile-twenty-client";
import { TwentyCustomerCrmClientV1 } from "./customer-profile-twenty-client";

const principal: RuntimePrincipalV2 = {
  userId: 59,
  adoptionId: "wealth-adoption",
  agentId: "wealth-agent",
  roleTemplate: "wealth-manager",
  workspaceId: "workspace",
  permissionProfile: "wealth-manager",
  sessionId: "session",
  tenantId: "tn_demo",
  organizationId: "org-demo",
  authorizationSnapshotId: "snapshot",
  authorizationFingerprint: "authorization",
  identityVersion: "2",
};

function customer(
  globalCustomerId: string,
  visibilityScope: TwentyCustomerSummaryV1["visibilityScope"]
): TwentyCustomerSummaryV1 {
  return {
    globalCustomerId,
    displayName: `客户-${globalCustomerId}`,
    customerStatus: "active",
    visibilityScope,
    tenantId: "tn_demo",
    ownerUserId: "59",
    businessAsOf: "2026-08-27T00:00:00.000Z",
  };
}

function assignment(globalCustomerId: string): TwentyCustomerAssignmentV1 {
  return {
    assignmentKey: `user:59:${globalCustomerId}`,
    globalCustomerId,
    organizationId: "org-demo",
    principalType: "user",
    principalRef: "59",
    businessDomain: "wealth",
    relationshipRole: "primary",
    assignmentStatus: "active",
  };
}

function adoptionAssignment(
  globalCustomerId: string
): TwentyCustomerAssignmentV1 {
  return {
    ...assignment(globalCustomerId),
    assignmentKey: `role-adoption:wealth-adoption:${globalCustomerId}`,
    principalType: "role_adoption",
    principalRef: "wealth-adoption",
  };
}

function client(input: {
  customers: TwentyCustomerSummaryV1[];
  assignments?: TwentyCustomerAssignmentV1[];
  roleEligibleCustomerIds?: string[];
}) {
  return {
    loadCustomerSummary: vi.fn(
      async (id: string) =>
        input.customers.find(item => item.globalCustomerId === id) || null
    ),
    listPublicCustomers: vi.fn(async () =>
      input.customers.filter(item => item.visibilityScope === "demo_public")
    ),
    listAssignmentsForPrincipal: vi.fn(async () => input.assignments || []),
    listCustomerIdsByProfileScope: vi.fn(
      async () =>
        input.roleEligibleCustomerIds ||
        input.customers.map(item => item.globalCustomerId)
    ),
  } as unknown as TwentyCustomerCrmClientV1;
}

afterEach(() => {
  delete process.env.EA_CUSTOMER_CONTEXT_TWENTY_TENANT_ID;
  delete process.env.EA_CUSTOMER_CONTEXT_TWENTY_ORGANIZATION_ID;
  delete process.env.EA_CUSTOMER_CONTEXT_TWENTY_ORGANIZATION_IDS;
});

describe("Twenty customer access", () => {
  it("allows supported roles to use demo-public customers", async () => {
    const decision = await evaluateTwentyCustomerAccess({
      client: client({ customers: [customer("CUST-000001", "demo_public")] }),
      principal,
      globalCustomerId: "CUST-000001",
    });
    expect(decision).toMatchObject({
      allowed: true,
      subjectInScope: true,
      allowedProfileTypes: ["wealth"],
    });
  });

  it("accepts only explicitly configured runtime organizations", async () => {
    process.env.EA_CUSTOMER_CONTEXT_TWENTY_ORGANIZATION_IDS =
      "org-other, org-demo";
    const accepted = await evaluateTwentyCustomerAccess({
      client: client({ customers: [customer("CUST-000020", "demo_public")] }),
      principal,
      globalCustomerId: "CUST-000020",
    });
    const rejected = await evaluateTwentyCustomerAccess({
      client: client({ customers: [customer("CUST-000020", "demo_public")] }),
      principal: { ...principal, organizationId: "org-unlisted" },
      globalCustomerId: "CUST-000020",
    });
    expect(accepted.subjectInScope).toBe(true);
    expect(rejected.subjectInScope).toBe(false);
  });

  it("requires an active assignment for restricted customers", async () => {
    const restricted = customer("CUST-000002", "restricted");
    const denied = await evaluateTwentyCustomerAccess({
      client: client({ customers: [restricted] }),
      principal,
      globalCustomerId: restricted.globalCustomerId,
    });
    expect(denied.subjectInScope).toBe(false);

    const allowed = await evaluateTwentyCustomerAccess({
      client: client({
        customers: [restricted],
        assignments: [assignment(restricted.globalCustomerId)],
      }),
      principal,
      globalCustomerId: restricted.globalCustomerId,
    });
    expect(allowed.subjectInScope).toBe(true);
  });

  it("supports a stable role-adoption assignment without trusting another environment user id", async () => {
    const restricted = customer("CUST-000021", "restricted");
    const allowed = await evaluateTwentyCustomerAccess({
      client: client({
        customers: [restricted],
        assignments: [adoptionAssignment(restricted.globalCustomerId)],
      }),
      principal: { ...principal, userId: 2 },
      globalCustomerId: restricted.globalCustomerId,
    });
    const denied = await evaluateTwentyCustomerAccess({
      client: client({
        customers: [restricted],
        assignments: [adoptionAssignment(restricted.globalCustomerId)],
      }),
      principal: { ...principal, adoptionId: "other-adoption" },
      globalCustomerId: restricted.globalCustomerId,
    });
    expect(allowed.subjectInScope).toBe(true);
    expect(denied.subjectInScope).toBe(false);
  });

  it("does not apply a wealth-only customer assignment in an insurance purpose", async () => {
    const restricted = customer("CUST-000004", "restricted");
    const decision = await evaluateTwentyCustomerAccess({
      client: client({
        customers: [restricted],
        assignments: [assignment(restricted.globalCustomerId)],
      }),
      principal: { ...principal, roleTemplate: "insurance-advisor" },
      globalCustomerId: restricted.globalCustomerId,
    });
    expect(decision).toMatchObject({ allowed: true, subjectInScope: false });
  });

  it("does not turn a shared customer source into authorization for other roles", async () => {
    const decision = await evaluateTwentyCustomerAccess({
      client: client({ customers: [customer("CUST-000003", "demo_public")] }),
      principal: { ...principal, roleTemplate: "investment-research" },
      globalCustomerId: "CUST-000003",
    });
    expect(decision).toMatchObject({ allowed: false, subjectInScope: true });
    expect(decision.allowedProfileTypes).toEqual([]);
  });

  it("lists dedicated customers before the shared demo pool without leaking restricted rows", async () => {
    const publicCustomer = customer("CUST-000010", "demo_public");
    const assignedCustomer = customer("CUST-000011", "restricted");
    const hiddenCustomer = customer("CUST-000012", "restricted");
    const rows = await listAuthorizedTwentyCustomers({
      client: client({
        customers: [publicCustomer, assignedCustomer, hiddenCustomer],
        assignments: [assignment(assignedCustomer.globalCustomerId)],
      }),
      principal,
    });
    expect(rows).toMatchObject([
      {
        globalCustomerId: "CUST-000011",
        accessScope: "assigned",
        relationshipRole: "primary",
        preferredForWrite: true,
      },
      {
        globalCustomerId: "CUST-000010",
        accessScope: "demo_public",
        relationshipRole: "demo_shared",
        preferredForWrite: false,
      },
    ]);
  });

  it("filters the customer directory by the active profile types allowed for the role", async () => {
    const wealthCustomer = customer("CUST-000001", "demo_public");
    const insuranceCustomer = customer("CUST-000101", "demo_public");
    const assignedWealthCustomer = customer("CUST-000201", "restricted");
    const rows = await listAuthorizedTwentyCustomers({
      client: client({
        customers: [wealthCustomer, insuranceCustomer, assignedWealthCustomer],
        assignments: [assignment(assignedWealthCustomer.globalCustomerId)],
        roleEligibleCustomerIds: [
          wealthCustomer.globalCustomerId,
          assignedWealthCustomer.globalCustomerId,
        ],
      }),
      principal,
    });
    expect(rows.map(row => row.globalCustomerId)).toEqual([
      "CUST-000201",
      "CUST-000001",
    ]);
  });
});
