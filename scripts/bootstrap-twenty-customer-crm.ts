import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CustomerCrmImportBundleV1 } from "../server/_core/customer-crm-import";

type JsonObject = Record<string, unknown>;

type FieldSpec = {
  name: string;
  label: string;
  type: string;
  isUnique?: boolean;
  isNullable?: boolean;
  isUIEditable?: boolean;
};

type ObjectSpec = {
  nameSingular: string;
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description: string;
  icon: string;
  fields: FieldSpec[];
};

type ModelSpec = {
  schemaVersion: "ea.twenty-customer-model.v2";
  objects: ObjectSpec[];
};

type MetadataObject = {
  id: string;
  nameSingular: string;
  namePlural: string;
  fieldsList: Array<{
    id: string;
    name: string;
    type: string;
    isUnique: boolean;
    isNullable: boolean;
    isUIEditable: boolean;
  }>;
};

function requiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function argument(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : fallback;
}

const baseUrl = requiredEnv("TWENTY_BASE_URL").replace(/\/$/u, "");
const existingApiKey = String(process.env.TWENTY_API_KEY || "").trim();
const adminEmail = String(process.env.TWENTY_ADMIN_EMAIL || "").trim();
const adminPassword = String(process.env.TWENTY_ADMIN_PASSWORD || "").trim();
const workspaceName =
  process.env.TWENTY_WORKSPACE_NAME || "Linggan Customer Operations";
const workspaceSubdomain =
  process.env.TWENTY_WORKSPACE_SUBDOMAIN || "linggan-customer-operations";
const apiKeyName = process.env.TWENTY_API_KEY_NAME || "灵感数据管理员";
const origin = process.env.TWENTY_ORIGIN || baseUrl;
const modelPath = path.resolve(
  argument("--model", "deploy/customer-crm/twenty/customer-model.v2.json")
);
const bundlePath = path.resolve(argument("--bundle"));
const apiKeyOutput = argument("--api-key-output");
if (!argument("--bundle"))
  throw new Error(
    "Usage requires --bundle <customer-crm-import-bundle.v1.json>"
  );

async function requestJson(input: {
  endpoint: string;
  token?: string;
  body: unknown;
}) {
  const response = await fetch(`${baseUrl}${input.endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    },
    body: JSON.stringify(input.body),
  });
  const text = await response.text();
  let json: JsonObject;
  try {
    json = text ? (JSON.parse(text) as JsonObject) : {};
  } catch {
    throw new Error(
      `Twenty returned non-JSON (${response.status}) on ${input.endpoint}: ${text.slice(0, 300)}`
    );
  }
  if (!response.ok)
    throw new Error(
      `Twenty request failed (${response.status}) on ${input.endpoint}: ${JSON.stringify(json).slice(0, 800)}`
    );
  return json;
}

async function requestRows(input: {
  objectNamePlural: string;
  token: string;
  limit?: number;
}): Promise<JsonObject[]> {
  const url = new URL(`/rest/${input.objectNamePlural}`, `${baseUrl}/`);
  url.searchParams.set("limit", String(input.limit ?? 1_000));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${input.token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json: JsonObject;
  try {
    json = text ? (JSON.parse(text) as JsonObject) : {};
  } catch {
    throw new Error(
      `Twenty returned non-JSON (${response.status}) on ${url.pathname}: ${text.slice(0, 300)}`
    );
  }
  if (!response.ok)
    throw new Error(
      `Twenty request failed (${response.status}) on ${url.pathname}: ${JSON.stringify(json).slice(0, 800)}`
    );
  const rows = (json.data as JsonObject | undefined)?.[input.objectNamePlural];
  if (!Array.isArray(rows))
    throw new Error(
      `Twenty response shape invalid on ${input.objectNamePlural}`
    );
  return rows.map(row => (row && typeof row === "object" ? row : {}));
}

async function graphql<T>(
  query: string,
  variables: JsonObject,
  token?: string
): Promise<T> {
  const json = await requestJson({
    endpoint: "/metadata",
    token,
    body: { query, variables },
  });
  const errors = Array.isArray(json.errors) ? json.errors : [];
  if (errors.length)
    throw new Error(
      `Twenty GraphQL error: ${JSON.stringify(errors).slice(0, 1200)}`
    );
  return json.data as T;
}

const LOGIN = `mutation Login($email:String!,$password:String!,$origin:String!){
  getLoginTokenFromCredentials(email:$email,password:$password,origin:$origin){loginToken{token}}
}`;
const SIGN_UP = `mutation SignUp($email:String!,$password:String!){
  signUp(email:$email,password:$password){tokens{accessOrWorkspaceAgnosticToken{token}}}
}`;
const CREATE_WORKSPACE = `mutation CreateWorkspace($input:SignUpInNewWorkspaceInput){
  signUpInNewWorkspace(input:$input){loginToken{token} workspace{id}}
}`;
const EXCHANGE_LOGIN = `mutation Exchange($loginToken:String!,$origin:String!){
  getAuthTokensFromLoginToken(loginToken:$loginToken,origin:$origin){
    tokens{accessOrWorkspaceAgnosticToken{token}}
  }
}`;
const ACTIVATE_WORKSPACE = `mutation ActivateWorkspace($input:ActivateWorkspaceInput!){
  activateWorkspace(data:$input){id activationStatus}
}`;

async function exchangeLoginToken(loginToken: string) {
  const data = await graphql<{
    getAuthTokensFromLoginToken: {
      tokens: { accessOrWorkspaceAgnosticToken: { token: string } };
    };
  }>(EXCHANGE_LOGIN, { loginToken, origin });
  return data.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken
    .token;
}

async function authenticateOrCreateWorkspace(): Promise<string> {
  if (!adminEmail || !adminPassword)
    throw new Error(
      "TWENTY_ADMIN_EMAIL and TWENTY_ADMIN_PASSWORD are required when TWENTY_API_KEY is unavailable"
    );
  try {
    const data = await graphql<{
      getLoginTokenFromCredentials: { loginToken: { token: string } };
    }>(LOGIN, { email: adminEmail, password: adminPassword, origin });
    return exchangeLoginToken(
      data.getLoginTokenFromCredentials.loginToken.token
    );
  } catch (loginError) {
    const signup = await graphql<{
      signUp: {
        tokens: { accessOrWorkspaceAgnosticToken: { token: string } };
      };
    }>(SIGN_UP, { email: adminEmail, password: adminPassword });
    const agnosticToken =
      signup.signUp.tokens.accessOrWorkspaceAgnosticToken.token;
    const created = await graphql<{
      signUpInNewWorkspace: { loginToken: { token: string } };
    }>(
      CREATE_WORKSPACE,
      { input: { displayName: workspaceName, subdomain: workspaceSubdomain } },
      agnosticToken
    );
    try {
      return await exchangeLoginToken(
        created.signUpInNewWorkspace.loginToken.token
      );
    } catch (error) {
      throw new AggregateError(
        [loginError, error],
        "Twenty workspace was created but access-token exchange failed"
      );
    }
  }
}

const OBJECTS = `query Objects {
  objects(paging:{first:1000}) { edges { node {
    id nameSingular namePlural fieldsList { id name type isUnique isNullable isUIEditable }
  } } }
}`;
const CREATE_OBJECT = `mutation CreateObject($input:CreateOneObjectInput!){
  createOneObject(input:$input){id nameSingular namePlural fieldsList{id name type isUnique isNullable isUIEditable}}
}`;
const CREATE_FIELD = `mutation CreateField($input:CreateOneFieldMetadataInput!){
  createOneField(input:$input){id name type isUnique isNullable isUIEditable object{id}}
}`;
const UPDATE_FIELD = `mutation UpdateField($input:UpdateOneFieldMetadataInput!){
  updateOneField(input:$input){id name type isUnique isNullable isUIEditable}
}`;
const UPDATE_OBJECT = `mutation UpdateObject($input:UpdateOneObjectInput!){
  updateOneObject(input:$input){id nameSingular namePlural fieldsList{id name type isUnique isNullable isUIEditable}}
}`;

const LEGACY_OBJECT_NAMES: Record<string, string> = {
  enterpriseCustomer: "graceCustomer",
};

const LEGACY_FIELD_NAMES: Record<string, string> = {
  "enterpriseCustomer.globalCustomerId": "graceCustomerId",
  "customerSourceLink.globalCustomerId": "graceCustomerId",
  "customerDomainProfile.globalCustomerId": "graceCustomerId",
  "customerSuggestion.globalCustomerId": "graceCustomerId",
  "customerInteraction.globalCustomerId": "graceCustomerId",
  "customerFollowupTask.globalCustomerId": "graceCustomerId",
};

async function listObjects(token: string): Promise<MetadataObject[]> {
  const data = await graphql<{
    objects: { edges: Array<{ node: MetadataObject }> };
  }>(OBJECTS, {}, token);
  return data.objects.edges.map(edge => edge.node);
}

async function ensureModel(token: string, model: ModelSpec) {
  const objects = await listObjects(token);
  for (const spec of model.objects) {
    let object = objects.find(item => item.nameSingular === spec.nameSingular);
    const legacyName = LEGACY_OBJECT_NAMES[spec.nameSingular];
    const legacyObject = legacyName
      ? objects.find(item => item.nameSingular === legacyName)
      : undefined;
    if (!object && legacyObject) {
      const data = await graphql<{ updateOneObject: MetadataObject }>(
        UPDATE_OBJECT,
        {
          input: {
            id: legacyObject.id,
            update: {
              nameSingular: spec.nameSingular,
              namePlural: spec.namePlural,
              labelSingular: spec.labelSingular,
              labelPlural: spec.labelPlural,
              description: spec.description,
              icon: spec.icon,
              isLabelSyncedWithName: false,
            },
          },
        },
        token
      );
      object = data.updateOneObject;
      Object.assign(legacyObject, object);
    }
    if (!object) {
      const data = await graphql<{ createOneObject: MetadataObject }>(
        CREATE_OBJECT,
        {
          input: {
            object: {
              nameSingular: spec.nameSingular,
              namePlural: spec.namePlural,
              labelSingular: spec.labelSingular,
              labelPlural: spec.labelPlural,
              description: spec.description,
              icon: spec.icon,
              isLabelSyncedWithName: false,
            },
          },
        },
        token
      );
      object = data.createOneObject;
      objects.push(object);
    }
    for (const field of spec.fields) {
      let existing = object.fieldsList.find(item => item.name === field.name);
      const legacyFieldName =
        LEGACY_FIELD_NAMES[`${spec.nameSingular}.${field.name}`];
      if (!existing && legacyFieldName) {
        const legacyField = object.fieldsList.find(
          item => item.name === legacyFieldName
        );
        if (legacyField) {
          const data = await graphql<{
            updateOneField: MetadataObject["fieldsList"][number];
          }>(
            UPDATE_FIELD,
            {
              input: {
                id: legacyField.id,
                update: {
                  name: field.name,
                  label: field.label,
                  isLabelSyncedWithName: false,
                  isNullable: field.isNullable !== false,
                  isUIEditable: field.isUIEditable !== false,
                },
              },
            },
            token
          );
          Object.assign(legacyField, data.updateOneField);
          existing = legacyField;
        }
      }
      if (existing) {
        if (
          existing.type !== field.type ||
          existing.isUnique !== (field.isUnique === true)
        )
          throw new Error(
            `Twenty field contract mismatch: ${spec.nameSingular}.${field.name}`
          );
        const expectedNullable = field.isNullable !== false;
        const expectedUIEditable = field.isUIEditable !== false;
        if (
          existing.isNullable !== expectedNullable ||
          existing.isUIEditable !== expectedUIEditable
        ) {
          const data = await graphql<{
            updateOneField: MetadataObject["fieldsList"][number];
          }>(
            UPDATE_FIELD,
            {
              input: {
                id: existing.id,
                update: {
                  isNullable: expectedNullable,
                  isUIEditable: expectedUIEditable,
                },
              },
            },
            token
          );
          Object.assign(existing, data.updateOneField);
        }
        continue;
      }
      const data = await graphql<{
        createOneField: MetadataObject["fieldsList"][number];
      }>(
        CREATE_FIELD,
        {
          input: {
            field: {
              objectMetadataId: object.id,
              type: field.type,
              name: field.name,
              label: field.label,
              isUnique: field.isUnique === true,
              isNullable: field.isNullable !== false,
              isUIEditable: field.isUIEditable !== false,
              isActive: true,
            },
          },
        },
        token
      );
      object.fieldsList.push(data.createOneField);
    }
  }
}

const GET_ROLES = `query Roles { getRoles { id label canBeAssignedToApiKeys } }`;
const CREATE_API_KEY = `mutation CreateApiKey($input:CreateApiKeyInput!){createApiKey(input:$input){id}}`;
const GENERATE_API_KEY = `mutation GenerateApiKey($apiKeyId:UUID!,$expiresAt:String!){
  generateApiKeyToken(apiKeyId:$apiKeyId,expiresAt:$expiresAt){token}
}`;

async function createApiKey(token: string): Promise<string> {
  const roles = await graphql<{
    getRoles: Array<{
      id: string;
      label: string;
      canBeAssignedToApiKeys: boolean;
    }>;
  }>(GET_ROLES, {}, token);
  const admin = roles.getRoles.find(
    role => role.label === "Admin" && role.canBeAssignedToApiKeys
  );
  if (!admin) throw new Error("Twenty Admin API-key role not found");
  const expiresAt = new Date(
    Date.now() + 3650 * 24 * 60 * 60 * 1000
  ).toISOString();
  const created = await graphql<{ createApiKey: { id: string } }>(
    CREATE_API_KEY,
    {
      input: {
        name: apiKeyName,
        expiresAt,
        roleId: admin.id,
      },
    },
    token
  );
  const generated = await graphql<{ generateApiKeyToken: { token: string } }>(
    GENERATE_API_KEY,
    { apiKeyId: created.createApiKey.id, expiresAt },
    token
  );
  return generated.generateApiKeyToken.token;
}

async function restBatchUpsert(
  objectNamePlural: string,
  records: JsonObject[],
  token: string
) {
  const batchSize = 60;
  for (let index = 0; index < records.length; index += batchSize) {
    await requestJson({
      endpoint: `/rest/batch/${objectNamePlural}?upsert=true`,
      token,
      body: records.slice(index, index + batchSize),
    });
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function profileContent(record: JsonObject): JsonObject {
  const rawJson = (value: unknown) => value ?? {};
  return {
    globalCustomerId: record.globalCustomerId,
    profileType: record.profileType,
    detailSchemaVersion: record.detailSchemaVersion,
    demographics: rawJson(record.demographics),
    preferences: rawJson(record.preferences),
    insuranceFacts: rawJson(record.insuranceFacts),
    detail: rawJson(record.detail),
    fieldProvenance: rawJson(record.fieldProvenance),
  };
}

function toTwentyRecords(
  bundle: CustomerCrmImportBundleV1,
  existingProfiles: JsonObject[]
) {
  const profilesByKey = new Map(
    existingProfiles.map(record => [String(record.profileKey || ""), record])
  );
  return {
    enterpriseCustomers: bundle.customers.map(record => {
      const { displayName, ...fields } = record;
      return { name: displayName, ...fields };
    }),
    customerAssignments: (bundle.assignments || []).map(record => ({
      name: `${record.principalType}:${record.principalRef}:${record.globalCustomerId}`,
      ...record,
    })),
    customerSourceLinks: bundle.sourceLinks.map(record => ({
      name: `${record.sourceSystem}:${record.sourceCustomerId}`,
      sourceLinkKey: `${record.sourceSystem}:${record.sourceTenantId}:${record.sourceCustomerId}`,
      ...record,
    })),
    customerDomainProfiles: bundle.domainProfiles.map(record => {
      const profileKey = `${record.globalCustomerId}:${record.profileType}`;
      const existing = profilesByKey.get(profileKey);
      const unchanged =
        existing &&
        canonicalJson(profileContent(existing)) ===
          canonicalJson(profileContent(record));
      return {
        name: profileKey,
        profileKey,
        ...record,
        runtimeStatus: unchanged
          ? String(existing.runtimeStatus || "candidate")
          : "candidate",
      };
    }),
    customerSuggestions: bundle.suggestions.map(record => ({
      name: `${record.globalCustomerId}:${record.suggestionType}`,
      suggestionKey: `${record.globalCustomerId}:${record.suggestionType}`,
      ...record,
    })),
  };
}

const model = JSON.parse(readFileSync(modelPath, "utf8")) as ModelSpec;
const bundle = JSON.parse(
  readFileSync(bundlePath, "utf8")
) as CustomerCrmImportBundleV1;
if (model.schemaVersion !== "ea.twenty-customer-model.v2")
  throw new Error("Unsupported Twenty customer model schema");
if (bundle.schemaVersion !== "ea.customer-crm-import-bundle.v1")
  throw new Error("Unsupported customer CRM import bundle schema");

const workspaceToken =
  existingApiKey || (await authenticateOrCreateWorkspace());
if (!existingApiKey) {
  const activation = await graphql<{
    activateWorkspace: { id: string; activationStatus: string };
  }>(ACTIVATE_WORKSPACE, { input: {} }, workspaceToken);
  if (activation.activateWorkspace.activationStatus !== "ACTIVE")
    throw new Error(
      `Twenty workspace activation incomplete: ${activation.activateWorkspace.activationStatus}`
    );
}
await ensureModel(workspaceToken, model);
let apiKey = existingApiKey;
if (apiKeyOutput && existsSync(apiKeyOutput)) {
  const line = readFileSync(apiKeyOutput, "utf8")
    .split(/\r?\n/u)
    .find(item => item.startsWith("TWENTY_API_KEY="));
  apiKey = line?.slice("TWENTY_API_KEY=".length).trim() || "";
}
if (!apiKey) {
  apiKey = await createApiKey(workspaceToken);
  if (apiKeyOutput) {
    writeFileSync(
      apiKeyOutput,
      `TWENTY_BASE_URL=${baseUrl}\nTWENTY_API_KEY=${apiKey}\n`,
      { mode: 0o600 }
    );
    chmodSync(apiKeyOutput, 0o600);
  }
}

const existingProfiles = await requestRows({
  objectNamePlural: "customerDomainProfiles",
  token: apiKey,
});
const records = toTwentyRecords(bundle, existingProfiles);
for (const [objectName, rows] of Object.entries(records))
  await restBatchUpsert(objectName, rows, apiKey);

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      status: "PASS",
      model: model.schemaVersion,
      bundle: bundle.schemaVersion,
      imported: Object.fromEntries(
        Object.entries(records).map(([name, rows]) => [name, rows.length])
      ),
      apiKeyStored: Boolean(apiKeyOutput),
    },
    null,
    2
  )
);
