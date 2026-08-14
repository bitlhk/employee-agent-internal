import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeTenantBinding, runtimeTenancyMode } from "./runtime-tenancy";

const previous = { ...process.env };

afterEach(() => {
  process.env = { ...previous };
});

describe("runtime tenancy", () => {
  it("preserves legacy organization and personal isolation by default", () => {
    delete process.env.EA_TENANCY_MODE;
    const organization = resolveRuntimeTenantBinding({ userId: 7, organizationName: " Example Bank " });
    const sameOrganization = resolveRuntimeTenantBinding({ userId: 9, organizationName: "example bank" });
    const personal = resolveRuntimeTenantBinding({ userId: 7, organizationName: null });
    const otherPersonal = resolveRuntimeTenantBinding({ userId: 9, organizationName: null });

    expect(runtimeTenancyMode()).toBe("legacy");
    expect(organization.tenantId).toBe(sameOrganization.tenantId);
    expect(personal.tenantId).not.toBe(otherPersonal.tenantId);
  });

  it("binds every demo user to the Linggan Finance asset tenant", () => {
    process.env.EA_TENANCY_MODE = "demo_single_org";
    process.env.EA_DEMO_TENANT_ID = "tn_linggan_finance";
    process.env.EA_DEMO_ORGANIZATION_ID = "org_linggan_finance";
    process.env.EA_DEMO_ORGANIZATION_NAME = "灵感金融";

    const first = resolveRuntimeTenantBinding({ userId: 7, organizationName: "Company A" });
    const second = resolveRuntimeTenantBinding({ userId: 9, organizationName: null });

    expect(first).toMatchObject({
      tenantId: "tn_linggan_finance",
      organizationId: "org_linggan_finance",
      displayName: "灵感金融",
      identitySource: "platform_demo",
      personal: false,
    });
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.organizationId).toBe(first.organizationId);
  });

  it("rejects invalid configured identifiers", () => {
    process.env.EA_TENANCY_MODE = "demo_single_org";
    process.env.EA_DEMO_TENANT_ID = "Linggan Finance";
    expect(() => resolveRuntimeTenantBinding({ userId: 7 })).toThrow(/EA_DEMO_TENANT_ID/);
  });
});
