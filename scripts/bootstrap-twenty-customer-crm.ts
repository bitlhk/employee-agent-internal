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
  schemaVersion: "ea.twenty-customer-model.v1";
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
const adminEmail = requiredEnv("TWENTY_ADMIN_EMAIL");
const adminPassword = requiredEnv("TWENTY_ADMIN_PASSWORD");
const workspaceName = process.env.TWENTY_WORKSPACE_NAME || "GRACE 客户运营";
const workspaceSubdomain = process.env.TWENTY_WORKSPACE_SUBDOMAIN || "grace";
const origin = process.env.TWENTY_ORIGIN || baseUrl;
const modelPath = path.resolve(
  argument("--model", "deploy/customer-crm/twenty/customer-model.v1.json")
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
    id nameSingular namePlural fieldsList { id name type isUnique isNullable }
  } } }
}`;
const CREATE_OBJECT = `mutation CreateObject($input:CreateOneObjectInput!){
  createOneObject(input:$input){id nameSingular namePlural fieldsList{id name type isUnique isNullable}}
}`;
const CREATE_FIELD = `mutation CreateField($input:CreateOneFieldMetadataInput!){
  createOneField(input:$input){id name type isUnique isNullable object{id}}
}`;

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
      const existing = object.fieldsList.find(item => item.name === field.name);
      if (existing) {
        if (
          existing.type !== field.type ||
          existing.isUnique !== (field.isUnique === true) ||
          existing.isNullable !== (field.isNullable !== false)
        )
          throw new Error(
            `Twenty field contract mismatch: ${spec.nameSingular}.${field.name}`
          );
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
        name: "GRACE Customer Context Adapter",
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

function toTwentyRecords(bundle: CustomerCrmImportBundleV1) {
  return {
    graceCustomers: bundle.customers.map(record => {
      const { displayName, ...fields } = record;
      return { name: displayName, ...fields };
    }),
    customerSourceLinks: bundle.sourceLinks.map(record => ({
      name: `${record.sourceSystem}:${record.sourceCustomerId}`,
      sourceLinkKey: `${record.sourceSystem}:${record.sourceTenantId}:${record.sourceCustomerId}`,
      ...record,
    })),
    customerDomainProfiles: bundle.domainProfiles.map(record => ({
      name: `${record.graceCustomerId}:${record.profileType}`,
      profileKey: `${record.graceCustomerId}:${record.profileType}`,
      ...record,
    })),
    customerSuggestions: bundle.suggestions.map(record => ({
      name: `${record.graceCustomerId}:${record.suggestionType}`,
      suggestionKey: `${record.graceCustomerId}:${record.suggestionType}`,
      ...record,
    })),
  };
}

const model = JSON.parse(readFileSync(modelPath, "utf8")) as ModelSpec;
const bundle = JSON.parse(
  readFileSync(bundlePath, "utf8")
) as CustomerCrmImportBundleV1;
if (model.schemaVersion !== "ea.twenty-customer-model.v1")
  throw new Error("Unsupported Twenty customer model schema");
if (bundle.schemaVersion !== "ea.customer-crm-import-bundle.v1")
  throw new Error("Unsupported customer CRM import bundle schema");

const workspaceToken = await authenticateOrCreateWorkspace();
const activation = await graphql<{
  activateWorkspace: { id: string; activationStatus: string };
}>(ACTIVATE_WORKSPACE, { input: {} }, workspaceToken);
if (activation.activateWorkspace.activationStatus !== "ACTIVE")
  throw new Error(
    `Twenty workspace activation incomplete: ${activation.activateWorkspace.activationStatus}`
  );
await ensureModel(workspaceToken, model);
let apiKey = "";
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

const records = toTwentyRecords(bundle);
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
