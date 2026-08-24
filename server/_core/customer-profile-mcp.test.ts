import { createServer, type Server } from "node:http";
import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import {
  customerProfileSourceFingerprint,
  type NormalizedCustomerProfileSourceV1,
} from "./customer-profile-source-adapters";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(async () => true),
  getClawByAdoptId: vi.fn(),
  getUserById: vi.fn(),
  resolveRuntimePrincipalV2: vi.fn(),
  audit: vi.fn(async () => undefined),
}));

vi.mock("./internal-runtime-request", () => ({
  authorizeAndBindInternalRuntimeRequest: mocks.authorize,
}));

vi.mock("../db", () => ({
  getClawByAdoptId: mocks.getClawByAdoptId,
  getUserById: mocks.getUserById,
}));

vi.mock("./governance/principal", () => ({
  resolveRuntimePrincipalV2: mocks.resolveRuntimePrincipalV2,
}));

vi.mock("./audit-events", () => ({
  auditRequest: vi.fn(() => ({})),
  recordAuditBestEffort: mocks.audit,
}));

import { loadCustomerProfileContracts } from "./customer-profile-contracts";
import {
  executeCustomerProfileProviderTool,
  registerCustomerProfileMcpRoutes,
  type CustomerProfileSourceLoaderV1,
} from "./customer-profile-mcp";

const NOW = "2026-08-24T07:00:00.000Z";
const principal: RuntimePrincipalV2 = {
  userId: 1,
  adoptionId: "lgj-wealth-demo",
  agentId: "jiuwen_lgj-wealth-demo",
  roleTemplate: "wealth-manager",
  workspaceId: "/tmp/wealth-demo",
  permissionProfile: "wealth-default",
  sessionId: "session-demo",
  taskId: "WM-GT-01",
  tenantId: "tenant-demo",
  organizationId: "organization-demo",
  authorizationSnapshotId: "authorization-snapshot-demo",
  authorizationFingerprint: "authorization-fingerprint-demo",
  identityVersion: "2",
};

function valueFor(path: string): unknown {
  if (path === "serviceScope.inScope") return true;
  if (path === "demographics.age") return 41;
  if (
    path.endsWith("confirmedNeeds") ||
    path.endsWith("complianceFlags") ||
    path.endsWith("protectionGaps")
  )
    return ["governed-value"];
  if (path === "insurance.vehicleSummary") return [{ vehicleRef: "masked" }];
  return `${path}:value`;
}

function completeSource(): NormalizedCustomerProfileSourceV1 {
  const { contract } = loadCustomerProfileContracts();
  const fields = contract.fields.map(field => ({
    path: field.path,
    value: valueFor(field.path),
    provenance: {
      sourceSystem: "enterprise_customer_master",
      sourceRecordRef: "customer-master:record-001",
      asOf: NOW,
      observedAt: NOW,
      mappingRuleVersion: "1.0.0",
    },
  }));
  const source: NormalizedCustomerProfileSourceV1 = {
    sourceContractId: "enterprise-customer-master-v1",
    sourceSystem: "enterprise_customer_master",
    subjectId: "CUST-001",
    sourceRecordRef: "customer-master:record-001",
    asOf: NOW,
    observedAt: NOW,
    productionReady: true,
    providerGaps: [],
    fields,
    resultFingerprint: "",
  };
  source.resultFingerprint = customerProfileSourceFingerprint(source);
  return source;
}

const sourceLoader = vi.fn<CustomerProfileSourceLoaderV1>(async () => ({
  sources: [completeSource()],
  principalAuthorized: true,
  subjectInScope: true,
  notes: [],
}));

function projectionFrom(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]?.text || "{}") as Record<string, unknown>;
}

describe("Customer Profile MCP tool", () => {
  it("derives purpose from the trusted Runtime Principal instead of tool arguments", async () => {
    const result = await executeCustomerProfileProviderTool({
      principal,
      args: {
        customer_id: "CUST-001",
        task_id: "WM-GT-01",
        roleTemplate: "insurance-advisor",
        purpose: "insurance_advisory",
      },
      sourceLoader,
    });
    const projection = projectionFrom(result);

    expect(projection.status).toBe("READY");
    expect(projection.projectionId).toBe("WealthCustomerProfileV1");
    expect(projection.purposeId).toBe("wealth_advisory");
    expect(
      (projection.fields as Array<{ path: string }>).some(field =>
        field.path.startsWith("insurance.")
      )
    ).toBe(false);
    expect(result._meta?.eaContextReceipt).toMatchObject({
      taskId: "WM-GT-01",
      provided: {
        businessData: [
          expect.objectContaining({
            logicalAssetId: "customer_profile",
            sourceSystem: "enterprise_customer_profile_provider",
          }),
        ],
      },
      readiness: { status: "READY" },
    });
  });
});

describe("Customer Profile MCP route", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerCustomerProfileMcpRoutes(app, { sourceLoader });
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("test server unavailable");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    process.env.EA_CUSTOMER_PROFILE_PROVIDER_SHADOW_ENABLED = "true";
    mocks.authorize.mockResolvedValue(true);
    mocks.getClawByAdoptId.mockResolvedValue({
      ...principal,
      adoptId: principal.adoptionId,
      status: "active",
    });
    mocks.getUserById.mockResolvedValue({
      id: principal.userId,
      organization: "Demo Bank",
      groupId: 1,
    });
    mocks.resolveRuntimePrincipalV2.mockResolvedValue({
      principal,
      complete: true,
      issues: [],
    });
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });

  async function rpc(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/internal/customer-profile/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-adopt-id": principal.adoptionId,
      },
      body: JSON.stringify(body),
    });
  }

  it("does not expose the tool while the shadow flag is disabled", async () => {
    process.env.EA_CUSTOMER_PROFILE_PROVIDER_SHADOW_ENABLED = "false";
    const response = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const body = await response.json();
    expect(body.result.tools).toEqual([]);
  });

  it("rejects requests that do not carry trusted internal runtime identity", async () => {
    mocks.authorize.mockResolvedValueOnce(false);
    const response = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(response.status).toBe(401);
  });

  it("returns a receipt-backed governed projection in shadow mode", async () => {
    const response = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_governed_customer_profile",
        arguments: {
          customer_id: "CUST-001",
          task_id: "WM-GT-01",
          purpose: "insurance_advisory",
        },
      },
    });
    const body = await response.json();
    expect(projectionFrom(body.result)).toMatchObject({
      projectionId: "WealthCustomerProfileV1",
      purposeId: "wealth_advisory",
      status: "READY",
    });
    expect(body.result._meta.eaContextReceipt.receiptFingerprint).toMatch(
      /^[a-f0-9]{64}$/u
    );
    expect(sourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ roleTemplate: "wealth-manager" }),
        subjectId: "CUST-001",
      })
    );
  });
});
