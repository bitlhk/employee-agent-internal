import type { RuntimePrincipalV2 } from "./governance/contracts";
import type {
  ConfirmedCustomerInteractionV1,
  CustomerFollowupTaskMirrorV1,
} from "./customer-crm-writeback";
import type {
  TwentyCustomerProfileRecordLoaderV1,
  TwentyCustomerProfileAggregateV1,
  TwentyCustomerProfileRecordV1,
} from "./customer-profile-twenty-adapter";

type JsonObject = Record<string, unknown>;

type TwentyFindManyResponseV1 = {
  data?: Record<string, unknown>;
  totalCount?: number;
};

export type TwentyCustomerAuthorizationDecisionV1 = {
  allowed: boolean;
  subjectInScope: boolean;
  authorizationEvidenceId: string;
  allowedProfileTypes: string[];
};

export type TwentyCustomerAuthorizationEvaluatorV1 = (input: {
  principal: RuntimePrincipalV2;
  globalCustomerId: string;
}) =>
  | TwentyCustomerAuthorizationDecisionV1
  | Promise<TwentyCustomerAuthorizationDecisionV1>;

export type TwentyCustomerSummaryV1 = {
  globalCustomerId: string;
  displayName: string;
  customerStatus: string;
  visibilityScope: "demo_public" | "restricted";
  tenantId: string;
  ownerUserId: string;
  businessAsOf: string;
  maskedPhone?: string;
};

export type TwentyCustomerAssignmentV1 = {
  assignmentKey: string;
  globalCustomerId: string;
  organizationId: string;
  principalType: "user" | "team" | "role_adoption";
  principalRef: string;
  businessDomain: string;
  relationshipRole: string;
  assignmentStatus: "active" | "inactive";
  validFrom?: string;
  validTo?: string;
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function string(value: unknown): string {
  return String(value ?? "").trim();
}

function jsonObject(value: unknown): JsonObject {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    throw new Error("TWENTY_CUSTOMER_CRM_JSON_FIELD_INVALID");
  }
}

function allowedBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("TWENTY_CUSTOMER_CRM_HTTPS_REQUIRED");
  return url.toString().replace(/\/$/u, "");
}

export class TwentyCustomerCrmClientV1 {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;

  constructor(input: {
    baseUrl: string;
    apiKey: string;
    timeoutMs?: number;
    request?: typeof fetch;
  }) {
    this.baseUrl = allowedBaseUrl(input.baseUrl);
    this.apiKey = input.apiKey.trim();
    if (!this.apiKey) throw new Error("TWENTY_CUSTOMER_CRM_API_KEY_REQUIRED");
    this.timeoutMs = input.timeoutMs ?? 10_000;
    this.request = input.request ?? fetch;
  }

  private async findMany(
    objectNamePlural: string,
    filter: string,
    limit = 2
  ): Promise<JsonObject[]> {
    const url = new URL(`/rest/${objectNamePlural}`, `${this.baseUrl}/`);
    url.searchParams.set("filter", filter);
    url.searchParams.set("limit", String(limit));
    const response = await this.request(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let body: TwentyFindManyResponseV1;
    try {
      body = text ? (JSON.parse(text) as TwentyFindManyResponseV1) : {};
    } catch {
      throw new Error("TWENTY_CUSTOMER_CRM_RESPONSE_INVALID");
    }
    if (!response.ok)
      throw new Error(`TWENTY_CUSTOMER_CRM_REQUEST_FAILED:${response.status}`);
    const rows = body.data?.[objectNamePlural];
    if (!Array.isArray(rows))
      throw new Error("TWENTY_CUSTOMER_CRM_RESPONSE_SHAPE_INVALID");
    return rows.map(object);
  }

  private customerSummary(row: JsonObject): TwentyCustomerSummaryV1 {
    return {
      globalCustomerId: string(row.globalCustomerId),
      displayName: string(row.name),
      customerStatus: string(row.customerStatus),
      visibilityScope:
        string(row.visibilityScope) === "demo_public"
          ? "demo_public"
          : "restricted",
      tenantId: string(row.tenantId),
      ownerUserId: string(row.ownerUserId),
      businessAsOf: string(row.businessAsOf),
      maskedPhone: string(row.maskedPhone) || undefined,
    };
  }

  async loadCustomerSummary(
    globalCustomerId: string
  ): Promise<TwentyCustomerSummaryV1 | null> {
    const id = globalCustomerId.trim();
    if (!id) throw new Error("TWENTY_CUSTOMER_CRM_GLOBAL_ID_REQUIRED");
    const rows = await this.findMany(
      "enterpriseCustomers",
      `globalCustomerId[eq]:${JSON.stringify(id)}`
    );
    if (!rows.length) return null;
    if (rows.length !== 1)
      throw new Error("TWENTY_CUSTOMER_CRM_GLOBAL_ID_AMBIGUOUS");
    return this.customerSummary(rows[0]);
  }

  async resolveGlobalCustomerId(input: {
    customerId: string;
    allowedSourceSystems: string[];
  }): Promise<string | null> {
    const customerId = input.customerId.trim();
    if (!customerId) return null;
    if (/^CUST-[0-9]{6}$/u.test(customerId)) return customerId;
    const allowedSources = new Set(
      input.allowedSourceSystems.map(item => item.trim()).filter(Boolean)
    );
    const links = await this.findMany(
      "customerSourceLinks",
      `sourceCustomerId[eq]:${JSON.stringify(customerId)}`,
      100
    );
    const matches = links.filter(link =>
      allowedSources.has(string(link.sourceSystem))
    );
    const globalIds = Array.from(
      new Set(
        matches.map(link => string(link.globalCustomerId)).filter(Boolean)
      )
    );
    if (globalIds.length > 1)
      throw new Error("TWENTY_CUSTOMER_CRM_SOURCE_ID_AMBIGUOUS");
    return globalIds[0] || null;
  }

  async listPublicCustomers(limit = 500): Promise<TwentyCustomerSummaryV1[]> {
    const rows = await this.findMany(
      "enterpriseCustomers",
      `visibilityScope[eq]:${JSON.stringify("demo_public")}`,
      Math.min(1_000, Math.max(1, limit))
    );
    return rows.map(row => this.customerSummary(row));
  }

  async listAssignmentsForPrincipal(
    principalRef: string,
    limit = 1_000
  ): Promise<TwentyCustomerAssignmentV1[]> {
    const ref = principalRef.trim();
    if (!ref) return [];
    const rows = await this.findMany(
      "customerAssignments",
      `principalRef[eq]:${JSON.stringify(ref)}`,
      Math.min(2_000, Math.max(1, limit))
    );
    return rows.map(row => ({
      assignmentKey: string(row.assignmentKey),
      globalCustomerId: string(row.globalCustomerId),
      organizationId: string(row.organizationId),
      principalType:
        string(row.principalType) === "team"
          ? "team"
          : string(row.principalType) === "role_adoption"
            ? "role_adoption"
            : "user",
      principalRef: string(row.principalRef),
      businessDomain: string(row.businessDomain),
      relationshipRole: string(row.relationshipRole),
      assignmentStatus:
        string(row.assignmentStatus) === "active" ? "active" : "inactive",
      validFrom: string(row.validFrom) || undefined,
      validTo: string(row.validTo) || undefined,
    }));
  }

  private async batchUpsert(
    objectNamePlural: "customerInteractions" | "customerFollowupTasks",
    records: JsonObject[]
  ): Promise<void> {
    const url = new URL(`/rest/batch/${objectNamePlural}`, `${this.baseUrl}/`);
    url.searchParams.set("upsert", "true");
    const response = await this.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(records),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new Error(`TWENTY_CUSTOMER_CRM_WRITE_FAILED:${response.status}`);
  }

  async loadCustomerProfile(input: {
    globalCustomerId: string;
    allowedProfileTypes: string[];
    allowedRuntimeStatuses?: Array<"candidate" | "active">;
  }): Promise<TwentyCustomerProfileAggregateV1 | null> {
    const id = input.globalCustomerId.trim();
    if (!id) throw new Error("TWENTY_CUSTOMER_CRM_GLOBAL_ID_REQUIRED");
    const allowedTypes = Array.from(
      new Set(
        input.allowedProfileTypes.map(item => item.trim()).filter(Boolean)
      )
    );
    if (!allowedTypes.length)
      throw new Error("TWENTY_CUSTOMER_CRM_PROFILE_SCOPE_REQUIRED");
    const quotedId = JSON.stringify(id);
    const profileTypeFilter =
      allowedTypes.length === 1
        ? `profileType[eq]:${JSON.stringify(allowedTypes[0])}`
        : `or(${allowedTypes
            .map(type => `profileType[eq]:${JSON.stringify(type)}`)
            .join(",")})`;
    const [customers, profiles] = await Promise.all([
      this.findMany("enterpriseCustomers", `globalCustomerId[eq]:${quotedId}`),
      this.findMany(
        "customerDomainProfiles",
        `and(globalCustomerId[eq]:${quotedId},${profileTypeFilter})`,
        20
      ),
    ]);
    if (!customers.length) return null;
    if (customers.length !== 1)
      throw new Error("TWENTY_CUSTOMER_CRM_GLOBAL_ID_AMBIGUOUS");
    const allowedRuntimeStatuses = new Set(
      input.allowedRuntimeStatuses?.length
        ? input.allowedRuntimeStatuses
        : ["active"]
    );
    const eligibleProfiles = profiles.filter(
      profile =>
        allowedTypes.includes(string(profile.profileType)) &&
        allowedRuntimeStatuses.has(
          string(profile.runtimeStatus) as "candidate" | "active"
        )
    );
    if (!eligibleProfiles.length)
      throw new Error("TWENTY_CUSTOMER_CRM_PROFILE_NOT_ELIGIBLE");
    const customer = customers[0];
    return {
      globalCustomerId: string(customer.globalCustomerId),
      displayName: string(customer.name),
      customerStatus: string(customer.customerStatus),
      visibilityScope:
        string(customer.visibilityScope) === "demo_public"
          ? "demo_public"
          : "restricted",
      tenantId: string(customer.tenantId),
      ownerUserId: string(customer.ownerUserId),
      businessAsOf: string(customer.businessAsOf),
      maskedPhone: string(customer.maskedPhone),
      profiles: eligibleProfiles.map(profile => ({
        profileType: string(profile.profileType),
        detailSchemaVersion: string(profile.detailSchemaVersion),
        runtimeStatus:
          string(profile.runtimeStatus) === "active"
            ? "active"
            : string(profile.runtimeStatus) === "retired"
              ? "retired"
              : "candidate",
        demographics: jsonObject(profile.demographics),
        preferences: jsonObject(profile.preferences),
        insuranceFacts: jsonObject(profile.insuranceFacts),
        detail: jsonObject(profile.detail),
        fieldProvenance: jsonObject(
          profile.fieldProvenance
        ) as TwentyCustomerProfileRecordV1["fieldProvenance"],
      })),
    };
  }

  async writeConfirmedInteraction(
    record: ConfirmedCustomerInteractionV1
  ): Promise<void> {
    await this.batchUpsert("customerInteractions", [
      {
        name: record.summary.slice(0, 255),
        ...record,
      },
    ]);
  }

  async writeFollowupTask(record: CustomerFollowupTaskMirrorV1): Promise<void> {
    await this.batchUpsert("customerFollowupTasks", [
      {
        name: record.subject,
        ...record,
      },
    ]);
  }
}

export function createTwentyCustomerProfileRecordLoaderV1(input: {
  client: TwentyCustomerCrmClientV1;
  authorize: TwentyCustomerAuthorizationEvaluatorV1;
  allowedRuntimeStatuses?: Array<"candidate" | "active">;
}): TwentyCustomerProfileRecordLoaderV1 {
  return async request => {
    const decision = await input.authorize(request);
    if (!decision.authorizationEvidenceId.trim())
      throw new Error("TWENTY_CUSTOMER_CRM_AUTHORIZATION_EVIDENCE_REQUIRED");
    if (!decision.allowed || !decision.subjectInScope) {
      return {
        record: null,
        principalAuthorized: decision.allowed,
        subjectInScope: decision.subjectInScope,
        authorizationEvidenceId: decision.authorizationEvidenceId,
      };
    }
    const record = await input.client.loadCustomerProfile({
      globalCustomerId: request.globalCustomerId,
      allowedProfileTypes: decision.allowedProfileTypes,
      allowedRuntimeStatuses: input.allowedRuntimeStatuses,
    });
    return record
      ? {
          record,
          principalAuthorized: true,
          subjectInScope: decision.subjectInScope,
          authorizationEvidenceId: decision.authorizationEvidenceId,
        }
      : null;
  };
}
