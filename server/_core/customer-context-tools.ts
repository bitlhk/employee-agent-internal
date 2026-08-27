import type { Request } from "express";
import {
  CUSTOMER_CONTEXT_CONTRACT,
  type CustomerContextRoleV1,
} from "../../shared/customer-context-contract";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import { governanceFingerprint } from "./governance/contracts";
import { executeEnterpriseMcpGatewayTool } from "./enterprise-mcp-gateway";
import {
  callInternalMcpTool,
  parseInternalMcpJsonResult,
} from "./internal-mcp-client";
import { normalizeWealthCustomerList } from "./wealth-maturity-context";
import { issueCustomerSourceDelegation } from "./customer-context-source-delegation";
import {
  createConfiguredTwentyCustomerClient,
  createConfiguredTwentyCustomerProfileLoader,
  listAuthorizedTwentyCustomers,
  twentyCustomerContextEnabled,
} from "./customer-context-twenty-access";

type JsonObject = Record<string, unknown>;

export type CustomerDirectoryScopeV1 = "all" | "assigned" | "demo_public";

export type CustomerDirectoryItemV1 = {
  customerId: string;
  displayName: string;
  accessScope?: "assigned" | "demo_public" | "authorized";
  businessDomain?: string;
  relationshipRole?: string;
  preferredForWrite?: boolean;
};

export type CustomerDirectoryResultV1 = {
  schemaVersion: "ea.customer-directory-result.v1";
  contract: typeof CUSTOMER_CONTEXT_CONTRACT;
  logicalContextId: "customer_directory";
  status: "READY" | "DEGRADED";
  query: string;
  scope: CustomerDirectoryScopeV1;
  scopeCounts: {
    assigned: number;
    demoPublic: number;
  };
  offset: number;
  limit: number;
  total: number;
  items: CustomerDirectoryItemV1[];
  sourceEvidence: CustomerContextSourceEvidenceV1[];
  generatedAt: string;
};

export type CustomerPortfolioResultV1 = {
  schemaVersion: "ea.customer-portfolio-result.v1";
  contract: typeof CUSTOMER_CONTEXT_CONTRACT;
  logicalContextId: "customer_portfolio";
  subjectId: string;
  status: "READY" | "DEGRADED";
  summary: Record<string, number | string>;
  holdings: Array<Record<string, number | string>>;
  maturities: Array<Record<string, number | string>>;
  sourceEvidence: CustomerContextSourceEvidenceV1[];
  generatedAt: string;
};

export type CustomerContextSourceEvidenceV1 = {
  sourceSystem: string;
  sourceRecordRef: string;
  asOf: string;
  resultFingerprint: string;
};

export type CustomerDirectoryLoaderV1 = (input: {
  principal: RuntimePrincipalV2;
  query: string;
  scope?: CustomerDirectoryScopeV1;
  offset: number;
  limit: number;
  request?: Request;
}) => Promise<CustomerDirectoryResultV1>;

export type CustomerPortfolioLoaderV1 = (input: {
  principal: RuntimePrincipalV2;
  subjectId: string;
  request?: Request;
}) => Promise<CustomerPortfolioResultV1>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(object).filter(item => Object.keys(item).length > 0)
    : [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(number)));
}

function resultError(result: JsonObject): string {
  return (Array.isArray(result.content) ? result.content : [])
    .map(object)
    .filter(item => item.type === "text")
    .map(item => String(item.text || ""))
    .join("\n")
    .trim()
    .slice(0, 1_000);
}

function parsedMcpResult(result: JsonObject): JsonObject {
  if (result.isError === true)
    throw new Error(
      `CUSTOMER_CONTEXT_UPSTREAM_DENIED:${resultError(result) || "remote MCP denied the call"}`
    );
  return parseInternalMcpJsonResult(result);
}

function wealthEndpointUrl(): string {
  return String(
    process.env.WEALTH_CUSTOMER_MCP_URL || "http://127.0.0.1:18008/mcp"
  ).trim();
}

async function callWealthTool(input: {
  principal: RuntimePrincipalV2;
  toolName: string;
  args: JsonObject;
}): Promise<JsonObject> {
  const delegation = issueCustomerSourceDelegation({
    principal: input.principal,
    sourceServerId: "wealth_assistant_customer",
  });
  return parsedMcpResult(
    await callInternalMcpTool({
      endpointUrl: wealthEndpointUrl(),
      toolName: input.toolName,
      args: input.args,
      agentId: delegation.sourceAgentId,
      adoptId: input.principal.adoptionId,
      sessionId: input.principal.sessionId,
    })
  );
}

async function callInsuranceTool(input: {
  principal: RuntimePrincipalV2;
  request?: Request;
  toolName: string;
  args: JsonObject;
}): Promise<JsonObject> {
  if (!input.request)
    throw new Error("CUSTOMER_CONTEXT_TRUSTED_REQUEST_REQUIRED");
  return parsedMcpResult(
    await executeEnterpriseMcpGatewayTool({
      req: input.request,
      adoptId: input.principal.adoptionId,
      sessionId: input.principal.sessionId,
      serverId: "insurance_customer_profile",
      toolName: input.toolName,
      arguments: input.args,
      taskAuthorizationSnapshotId: input.principal.authorizationSnapshotId,
      executionOrigin: "customer_profile_adapter",
    })
  );
}

function sourceEvidence(input: {
  sourceSystem: string;
  sourceRecordRef: string;
  asOf: string;
  value: unknown;
}): CustomerContextSourceEvidenceV1 {
  return {
    sourceSystem: input.sourceSystem,
    sourceRecordRef: input.sourceRecordRef,
    asOf: input.asOf,
    resultFingerprint: governanceFingerprint(input.value),
  };
}

function insuranceDirectoryItems(
  payload: JsonObject
): CustomerDirectoryItemV1[] {
  return array(payload.items)
    .map(item => ({
      customerId: firstString(item.id, item.customerId, item.customer_id),
      displayName: firstString(
        item.name,
        item.customerName,
        item.customer_name
      ),
    }))
    .filter(item => item.customerId);
}

function filterDirectory(
  items: CustomerDirectoryItemV1[],
  query: string
): CustomerDirectoryItemV1[] {
  const normalized = query.trim().toLocaleLowerCase();
  const unique = items.filter(
    (item, index, rows) =>
      rows.findIndex(candidate => candidate.customerId === item.customerId) ===
      index
  );
  if (!normalized) return unique;
  return unique.filter(item =>
    `${item.customerId}\n${item.displayName}`
      .toLocaleLowerCase()
      .includes(normalized)
  );
}

function filterDirectoryScope(
  items: CustomerDirectoryItemV1[],
  scope: CustomerDirectoryScopeV1
): CustomerDirectoryItemV1[] {
  if (scope === "assigned")
    return items.filter(item => item.accessScope === "assigned");
  if (scope === "demo_public")
    return items.filter(item => item.accessScope === "demo_public");
  return items;
}

function directoryScopeCounts(items: CustomerDirectoryItemV1[]) {
  return {
    assigned: items.filter(item => item.accessScope === "assigned").length,
    demoPublic: items.filter(item => item.accessScope === "demo_public").length,
  };
}

export const defaultCustomerDirectoryLoader: CustomerDirectoryLoaderV1 =
  async input => {
    const role = input.principal.roleTemplate as CustomerContextRoleV1;
    const requestedScope = input.scope || "all";
    const generatedAt = new Date().toISOString();
    if (twentyCustomerContextEnabled()) {
      const customers = await listAuthorizedTwentyCustomers({
        client: createConfiguredTwentyCustomerClient(),
        principal: input.principal,
      });
      const accessible = filterDirectory(
        customers.map(customer => ({
          customerId: customer.globalCustomerId,
          displayName: customer.displayName,
          accessScope: customer.accessScope,
          businessDomain: customer.businessDomain,
          relationshipRole: customer.relationshipRole,
          preferredForWrite: customer.preferredForWrite,
        })),
        input.query
      );
      const scopeCounts = directoryScopeCounts(accessible);
      const all = filterDirectoryScope(accessible, requestedScope);
      return {
        schemaVersion: "ea.customer-directory-result.v1",
        contract: CUSTOMER_CONTEXT_CONTRACT,
        logicalContextId: "customer_directory",
        status: "READY",
        query: input.query,
        scope: requestedScope,
        scopeCounts,
        offset: input.offset,
        limit: input.limit,
        total: all.length,
        items: all.slice(input.offset, input.offset + input.limit),
        sourceEvidence: [
          sourceEvidence({
            sourceSystem: "twenty_crm",
            sourceRecordRef: `authorized-customer-directory:${input.principal.organizationId}`,
            asOf: generatedAt,
            value: all,
          }),
        ],
        generatedAt,
      };
    }
    if (role === "wealth-manager") {
      const requested = Math.min(
        500,
        Math.max(100, input.offset + input.limit)
      );
      const payload = await callWealthTool({
        principal: input.principal,
        toolName: "wealth_assistant_customer_list",
        args: { page: 1, pageSize: requested },
      });
      const all = filterDirectory(
        normalizeWealthCustomerList(payload).map(item => ({
          customerId: item.customerId,
          displayName: item.customerName,
          accessScope: "authorized" as const,
          businessDomain: "wealth",
          relationshipRole: "legacy_authorized",
          preferredForWrite: false,
        })),
        input.query
      );
      const asOf = firstString(
        payload.asOf,
        payload.updatedAt,
        object(payload.data).asOf,
        object(payload.data).updatedAt,
        generatedAt
      );
      return {
        schemaVersion: "ea.customer-directory-result.v1",
        contract: CUSTOMER_CONTEXT_CONTRACT,
        logicalContextId: "customer_directory",
        status: "READY",
        query: input.query,
        scope: requestedScope,
        scopeCounts: { assigned: 0, demoPublic: 0 },
        offset: input.offset,
        limit: input.limit,
        total: all.length,
        items: all.slice(input.offset, input.offset + input.limit),
        sourceEvidence: [
          sourceEvidence({
            sourceSystem: "wealth_assistant_customer",
            sourceRecordRef: "authorized-customer-directory",
            asOf,
            value: payload,
          }),
        ],
        generatedAt,
      };
    }
    if (role === "insurance-advisor") {
      const payload = await callInsuranceTool({
        principal: input.principal,
        request: input.request,
        toolName: "list_customer_profiles",
        args: {
          limit: Math.min(
            100,
            Math.max(input.limit, input.offset + input.limit)
          ),
          offset: 0,
        },
      });
      const all = filterDirectory(
        insuranceDirectoryItems(payload).map(item => ({
          ...item,
          accessScope: "authorized" as const,
          businessDomain: "insurance",
          relationshipRole: "legacy_authorized",
          preferredForWrite: false,
        })),
        input.query
      );
      const asOf = firstString(payload.asOf, payload.updatedAt, generatedAt);
      return {
        schemaVersion: "ea.customer-directory-result.v1",
        contract: CUSTOMER_CONTEXT_CONTRACT,
        logicalContextId: "customer_directory",
        status: "READY",
        query: input.query,
        scope: requestedScope,
        scopeCounts: { assigned: 0, demoPublic: 0 },
        offset: input.offset,
        limit: input.limit,
        total:
          Number.isFinite(Number(payload.total)) && !input.query
            ? Number(payload.total)
            : all.length,
        items: all.slice(input.offset, input.offset + input.limit),
        sourceEvidence: [
          sourceEvidence({
            sourceSystem: "insurance_customer_profile",
            sourceRecordRef: "authorized-customer-directory",
            asOf,
            value: payload,
          }),
        ],
        generatedAt,
      };
    }
    throw new Error("CUSTOMER_DIRECTORY_ROLE_NOT_SUPPORTED");
  };

function dataObject(payload: JsonObject): JsonObject {
  const data = object(payload.data);
  return Object.keys(data).length ? data : payload;
}

function customerObject(payload: JsonObject): JsonObject {
  const data = dataObject(payload);
  const nested = object(data.customer);
  if (Object.keys(nested).length) return nested;
  const direct = object(payload.customer);
  return Object.keys(direct).length ? direct : data;
}

function rows(source: JsonObject, keys: string[]): JsonObject[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return array(value);
  }
  return [];
}

function pickString(row: JsonObject, keys: string[]): string {
  return firstString(...keys.map(key => row[key]));
}

function pickNumber(row: JsonObject, keys: string[]): number | null {
  return finiteNumber(...keys.map(key => row[key]));
}

function compactRecord(
  row: JsonObject,
  fields: Record<string, { strings?: string[]; numbers?: string[] }>
): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  for (const [target, source] of Object.entries(fields)) {
    const stringValue = source.strings ? pickString(row, source.strings) : "";
    const numberValue = source.numbers ? pickNumber(row, source.numbers) : null;
    if (stringValue) result[target] = stringValue.slice(0, 300);
    else if (numberValue !== null) result[target] = numberValue;
  }
  return result;
}

export function normalizeWealthCustomerPortfolio(input: {
  payload: JsonObject;
  expectedSubjectId: string;
  now?: Date;
}): CustomerPortfolioResultV1 {
  const generatedAt = (input.now || new Date()).toISOString();
  const source = dataObject(input.payload);
  const customer = customerObject(input.payload);
  const returnedId = firstString(
    customer.customerId,
    customer.customer_id,
    customer.CUST_NO,
    customer.id
  );
  if (!returnedId || returnedId !== input.expectedSubjectId)
    throw new Error("CUSTOMER_PORTFOLIO_SOURCE_SUBJECT_MISMATCH");
  const asset = object(source.assetInfo || source.asset_info);
  const summary = compactRecord(asset, {
    totalAssets: {
      numbers: ["FINC_AST_CNY_BAL", "totalAssets", "total_assets", "aum"],
    },
    availableCash: {
      numbers: ["checking", "availableCash", "available_cash", "cashBalance"],
    },
    investedAssets: {
      numbers: ["investments", "investedAssets", "invested_assets"],
    },
    dataAsOf: {
      strings: ["dataAsOf", "data_as_of", "updatedAt", "updated_at"],
    },
  });
  const holdingRows = rows(source, [
    "heldProducts",
    "held_products",
    "holdings",
    "positions",
  ]);
  const maturityRows = rows(source, [
    "maturedProducts",
    "matured_products",
    "expiringProducts",
    "expiring_products",
    "upcomingMaturities",
    "upcoming_maturities",
  ]);
  const holdings = holdingRows
    .map(row =>
      compactRecord(row, {
        productRef: {
          strings: [
            "productId",
            "product_id",
            "productCode",
            "product_code",
            "id",
          ],
        },
        productName: { strings: ["productName", "product_name", "name"] },
        category: {
          strings: ["category", "productCategory", "product_category", "type"],
        },
        balance: {
          numbers: [
            "balance",
            "amount",
            "principal",
            "marketValue",
            "market_value",
          ],
        },
        status: { strings: ["status", "productStatus", "product_status"] },
        holdingSince: {
          strings: ["holdingSince", "holding_since", "startDate", "start_date"],
        },
        maturityDate: {
          strings: [
            "maturityDate",
            "maturity_date",
            "expiryDate",
            "expiry_date",
            "endDate",
            "end_date",
          ],
        },
      })
    )
    .filter(row => Object.keys(row).length > 0);
  const maturities = maturityRows
    .map(row =>
      compactRecord(row, {
        productRef: {
          strings: [
            "productId",
            "product_id",
            "productCode",
            "product_code",
            "id",
          ],
        },
        productName: { strings: ["productName", "product_name", "name"] },
        amount: {
          numbers: [
            "amount",
            "maturityAmount",
            "maturity_amount",
            "principal",
            "balance",
          ],
        },
        maturityDate: {
          strings: [
            "maturityDate",
            "maturity_date",
            "expiryDate",
            "expiry_date",
            "endDate",
            "end_date",
          ],
        },
        status: { strings: ["status", "productStatus", "product_status"] },
      })
    )
    .filter(row => Object.keys(row).length > 0);
  const asOf = firstString(
    input.payload.asOf,
    input.payload.updatedAt,
    source.asOf,
    source.updatedAt,
    customer.dataAsOf,
    customer.data_as_of,
    customer.updatedAt,
    customer.updated_at,
    summary.dataAsOf,
    generatedAt
  );
  const minimized = { subjectId: returnedId, summary, holdings, maturities };
  return {
    schemaVersion: "ea.customer-portfolio-result.v1",
    contract: CUSTOMER_CONTEXT_CONTRACT,
    logicalContextId: "customer_portfolio",
    subjectId: returnedId,
    status:
      holdings.length || maturities.length || Object.keys(summary).length
        ? "READY"
        : "DEGRADED",
    summary,
    holdings,
    maturities,
    sourceEvidence: [
      sourceEvidence({
        sourceSystem: "wealth_assistant_customer",
        sourceRecordRef: `customer:${returnedId}:portfolio`,
        asOf,
        value: minimized,
      }),
    ],
    generatedAt,
  };
}

export const defaultCustomerPortfolioLoader: CustomerPortfolioLoaderV1 =
  async input => {
    if (input.principal.roleTemplate !== "wealth-manager")
      throw new Error("CUSTOMER_PORTFOLIO_ROLE_NOT_AUTHORIZED");
    if (twentyCustomerContextEnabled()) {
      const loaded = await createConfiguredTwentyCustomerProfileLoader()({
        globalCustomerId: input.subjectId,
        principal: input.principal,
      });
      if (
        !loaded?.record ||
        !loaded.principalAuthorized ||
        !loaded.subjectInScope
      )
        throw new Error("CUSTOMER_PORTFOLIO_SUBJECT_NOT_AUTHORIZED");
      const wealth = loaded.record.profiles.find(
        profile => profile.profileType === "wealth"
      );
      if (!wealth) throw new Error("CUSTOMER_PORTFOLIO_PROFILE_NOT_AVAILABLE");
      const detail = object(wealth.detail);
      const result = normalizeWealthCustomerPortfolio({
        payload: {
          customer: {
            customerId: loaded.record.globalCustomerId,
            dataAsOf: loaded.record.businessAsOf,
          },
          assetInfo: object(
            detail.portfolioSummary || detail.assetAllocationSummary
          ),
          heldProducts: Array.isArray(detail.holdings) ? detail.holdings : [],
          maturedProducts: Array.isArray(detail.maturities)
            ? detail.maturities
            : [],
        },
        expectedSubjectId: loaded.record.globalCustomerId,
      });
      result.sourceEvidence = [
        sourceEvidence({
          sourceSystem: "twenty_crm",
          sourceRecordRef: `customer:${loaded.record.globalCustomerId}:portfolio`,
          asOf: loaded.record.businessAsOf,
          value: {
            subjectId: result.subjectId,
            summary: result.summary,
            holdings: result.holdings,
            maturities: result.maturities,
          },
        }),
      ];
      return result;
    }
    const payload = await callWealthTool({
      principal: input.principal,
      toolName: "wealth_assistant_customer_detail",
      args: { customerId: input.subjectId },
    });
    return normalizeWealthCustomerPortfolio({
      payload,
      expectedSubjectId: input.subjectId,
    });
  };

export function customerDirectoryRequest(args: JsonObject) {
  const requestedScope = firstString(args.scope);
  const scope: CustomerDirectoryScopeV1 = ["assigned", "demo_public"].includes(
    requestedScope
  )
    ? (requestedScope as CustomerDirectoryScopeV1)
    : "all";
  return {
    query: firstString(args.query, args.keyword, args.name).slice(0, 200),
    scope,
    offset: boundedInteger(args.offset, 0, 10_000),
    limit: Math.max(
      1,
      boundedInteger(args.limit ?? args.page_size ?? args.pageSize, 20, 100)
    ),
  };
}
