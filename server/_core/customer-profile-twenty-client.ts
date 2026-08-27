import type { RuntimePrincipalV2 } from "./governance/contracts";
import type {
  ConfirmedCustomerInteractionV1,
  CustomerFollowupTaskMirrorV1,
} from "./customer-crm-writeback";
import type {
  TwentyCustomerProfileRecordLoaderV1,
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
  graceCustomerId: string;
}) =>
  | TwentyCustomerAuthorizationDecisionV1
  | Promise<TwentyCustomerAuthorizationDecisionV1>;

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
    graceCustomerId: string;
    allowedProfileTypes: string[];
  }): Promise<TwentyCustomerProfileRecordV1 | null> {
    const id = input.graceCustomerId.trim();
    if (!id) throw new Error("TWENTY_CUSTOMER_CRM_GLOBAL_ID_REQUIRED");
    const allowedTypes = Array.from(
      new Set(
        input.allowedProfileTypes.map(item => item.trim()).filter(Boolean)
      )
    );
    if (!allowedTypes.length)
      throw new Error("TWENTY_CUSTOMER_CRM_PROFILE_SCOPE_REQUIRED");
    const quotedId = JSON.stringify(id);
    const [customers, profiles] = await Promise.all([
      this.findMany("graceCustomers", `graceCustomerId[eq]:${quotedId}`),
      this.findMany(
        "customerDomainProfiles",
        `graceCustomerId[eq]:${quotedId}`,
        20
      ),
    ]);
    if (!customers.length) return null;
    if (customers.length !== 1)
      throw new Error("TWENTY_CUSTOMER_CRM_GLOBAL_ID_AMBIGUOUS");
    const eligibleProfiles = profiles.filter(profile =>
      allowedTypes.includes(string(profile.profileType))
    );
    if (eligibleProfiles.length !== 1)
      throw new Error(
        eligibleProfiles.length
          ? "TWENTY_CUSTOMER_CRM_PROFILE_AMBIGUOUS"
          : "TWENTY_CUSTOMER_CRM_PROFILE_NOT_ELIGIBLE"
      );
    const customer = customers[0];
    const profile = eligibleProfiles[0];
    return {
      graceCustomerId: string(customer.graceCustomerId),
      displayName: string(customer.name),
      customerStatus: string(customer.customerStatus),
      tenantId: string(customer.tenantId),
      ownerUserId: string(customer.ownerUserId),
      businessAsOf: string(customer.businessAsOf),
      maskedPhone: string(customer.maskedPhone),
      profileType: string(profile.profileType),
      detailSchemaVersion: string(profile.detailSchemaVersion),
      demographics: jsonObject(profile.demographics),
      preferences: jsonObject(profile.preferences),
      insuranceFacts: jsonObject(profile.insuranceFacts),
      detail: jsonObject(profile.detail),
      fieldProvenance: jsonObject(
        profile.fieldProvenance
      ) as TwentyCustomerProfileRecordV1["fieldProvenance"],
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
      graceCustomerId: request.graceCustomerId,
      allowedProfileTypes: decision.allowedProfileTypes,
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
