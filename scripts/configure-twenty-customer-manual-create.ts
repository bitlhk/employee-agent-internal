type JsonObject = Record<string, unknown>;

function requiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

const baseUrl = requiredEnv("TWENTY_BASE_URL").replace(/\/$/u, "");
const apiKey = requiredEnv("TWENTY_API_KEY");

async function request(input: {
  path: string;
  method?: string;
  body?: unknown;
}) {
  const response = await fetch(`${baseUrl}${input.path}`, {
    method: input.method || "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(input.body ? { "Content-Type": "application/json" } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as JsonObject) : {};
  if (!response.ok)
    throw new Error(
      `Twenty request failed (${response.status}) on ${input.path}: ${JSON.stringify(json).slice(0, 800)}`
    );
  return json;
}

const OBJECTS = `query Objects {
  objects(paging:{first:1000}) { edges { node {
    id nameSingular fieldsList { id name isNullable isUIEditable }
  } } }
}`;
async function metadata<T>(query: string, variables: JsonObject): Promise<T> {
  const response = await request({
    path: "/metadata",
    method: "POST",
    body: { query, variables },
  });
  const errors = Array.isArray(response.errors) ? response.errors : [];
  if (errors.length)
    throw new Error(`Twenty GraphQL error: ${JSON.stringify(errors)}`);
  return response.data as T;
}

async function verifyGlobalIdField() {
  const data = await metadata<{
    objects: {
      edges: Array<{
        node: {
          id: string;
          nameSingular: string;
          fieldsList: Array<{
            id: string;
            name: string;
            isNullable: boolean;
            isUIEditable: boolean;
          }>;
        };
      }>;
    };
  }>(OBJECTS, {});
  const customer = data.objects.edges
    .map(edge => edge.node)
    .find(item => item.nameSingular === "enterpriseCustomer");
  const field = customer?.fieldsList.find(
    item => item.name === "globalCustomerId"
  );
  if (!field) throw new Error("TWENTY_CUSTOMER_GLOBAL_ID_FIELD_NOT_FOUND");
  if (!field.isNullable || field.isUIEditable)
    throw new Error("TWENTY_CUSTOMER_GLOBAL_ID_METADATA_NOT_CONFIGURED");
  return field;
}

async function findByName(name: string) {
  const filter = encodeURIComponent(`name[eq]:${JSON.stringify(name)}`);
  const response = await request({
    path: `/rest/enterpriseCustomers?filter=${filter}&limit=2`,
  });
  const rows = object(response.data).enterpriseCustomers;
  return Array.isArray(rows) ? rows.map(object) : [];
}

async function verifyManualCreate() {
  const name = `客户新增验收-${Date.now()}`;
  let recordId = "";
  try {
    await request({
      path: "/rest/enterpriseCustomers",
      method: "POST",
      body: { name },
    });
    const rows = await findByName(name);
    if (rows.length !== 1)
      throw new Error("TWENTY_CUSTOMER_MANUAL_CREATE_RESULT_AMBIGUOUS");
    const record = rows[0]!;
    recordId = String(record.id || "").trim();
    const globalCustomerId = String(record.globalCustomerId || "").trim();
    if (!/^CUST-9[0-9]{5}$/u.test(globalCustomerId))
      throw new Error("TWENTY_CUSTOMER_MANUAL_ID_NOT_ASSIGNED");
    if (String(record.customerStatus || "") !== "draft")
      throw new Error("TWENTY_CUSTOMER_MANUAL_STATUS_NOT_DRAFT");
    if (String(record.visibilityScope || "") !== "restricted")
      throw new Error("TWENTY_CUSTOMER_MANUAL_VISIBILITY_NOT_RESTRICTED");
    if (String(record.tenantId || "") !== "tn_linggan_finance")
      throw new Error("TWENTY_CUSTOMER_MANUAL_TENANT_NOT_ASSIGNED");
    return { globalCustomerId, status: "PASS" as const };
  } finally {
    if (recordId) {
      await request({
        path: `/rest/enterpriseCustomers/${encodeURIComponent(recordId)}?soft_delete=false`,
        method: "DELETE",
      });
    }
  }
}

const field = await verifyGlobalIdField();
const verification = await verifyManualCreate();

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      schemaVersion: "ea.twenty-customer-manual-create-verification.v1",
      status: "PASS",
      globalIdField: {
        name: field.name,
        nullableAtApiBoundary: field.isNullable,
        readOnlyInUi: !field.isUIEditable,
        requiredAfterPersistence: true,
      },
      verification,
    },
    null,
    2
  )
);
