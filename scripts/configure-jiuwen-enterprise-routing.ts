type ManagerEnvelope<T> = {
  code?: number;
  message?: string;
  data?: T;
};

type PolicyRecord = {
  id: number;
  policy_id: string;
  policy_name: string;
  service_id?: string;
  agent_id?: string;
  workspace_dir?: string;
  service_policy_id?: string;
  match_expr?: string;
  enabled?: boolean;
};

const SERVICE_POLICY_NAME = "EA岗位运行时分片路由";
const AGENT_POLICY_NAME = "EA岗位实例隔离";

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 256) {
    throw new Error(`${name} must be an integer between 1 and 256`);
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function apiUrl(baseUrl: string, instanceId: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/api/v1/instances/${encodeURIComponent(instanceId)}${path}`;
}

async function managerRequest<T>(
  baseUrl: string,
  instanceId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = String(process.env.JIUWEN_ENTERPRISE_MANAGER_TOKEN || "").trim();
  const response = await fetch(apiUrl(baseUrl, instanceId, path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json() as ManagerEnvelope<T>;
  if (!response.ok || (payload.code != null && payload.code !== 200) || payload.data == null) {
    throw new Error(`Manager ${init.method || "GET"} ${path} failed: ${response.status} ${payload.message || "invalid response"}`);
  }
  return payload.data;
}

async function listPolicies(
  baseUrl: string,
  instanceId: string,
  kind: "service" | "agent",
): Promise<PolicyRecord[]> {
  const data = await managerRequest<{ items?: PolicyRecord[] }>(
    baseUrl,
    instanceId,
    `/config-effective/${kind}-policies/?page=1&page_size=100`,
  );
  return Array.isArray(data.items) ? data.items : [];
}

function assertExistingPolicy(
  policy: PolicyRecord,
  expected: Partial<PolicyRecord>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (policy[key as keyof PolicyRecord] !== value) {
      throw new Error(`${policy.policy_name} exists but ${key} differs; update it through a reviewed manager change`);
    }
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const baseUrl = requiredEnv("JIUWEN_ENTERPRISE_MANAGER_BASE_URL");
  const instanceId = requiredEnv("JIUWEN_ENTERPRISE_INSTANCE_ID");
  const shardCount = integerEnv("EA_ENTERPRISE_RUNTIME_SHARDS", 16);
  const quote = "'";
  const matchExpr = Array.from(
    { length: shardCount },
    (_, shard) => `group_id == ${quote}ea_s${shard}${quote}`,
  ).join(" or ");

  const servicePayload = {
    policy_name: SERVICE_POLICY_NAME,
    policy_desc: "Linggan EA finite logical shards; authorization remains in EA Principal and PEP",
    service_id: "${group_id}::${bot_id}",
    priority: 200,
    match_expr: matchExpr,
    template_ref: {},
    enabled: true,
    data: { owner: "employee-agent", version: "v1" },
  };

  const services = await listPolicies(baseUrl, instanceId, "service");
  let service = services.find((item) => item.policy_name === SERVICE_POLICY_NAME);
  if (service) {
    assertExistingPolicy(service, {
      service_id: servicePayload.service_id,
      match_expr: servicePayload.match_expr,
      enabled: true,
    });
  } else if (apply) {
    service = await managerRequest<PolicyRecord>(baseUrl, instanceId, "/config-effective/service-policies/", {
      method: "POST",
      body: JSON.stringify(servicePayload),
    });
  }

  if (!service) {
    console.log(JSON.stringify({ apply: false, action: "create", servicePolicy: servicePayload }, null, 2));
    return;
  }

  const agentPayload = {
    policy_name: AGENT_POLICY_NAME,
    policy_desc: "Stable opaque identity and per-adoption shared workspace",
    agent_id: "${user_id}",
    workspace_dir: "${group_id}::${bot_id}::${user_id}",
    service_policy_id: service.policy_id,
    priority: 200,
    match_expr: "",
    template_ref: {},
    enabled: true,
    data: { owner: "employee-agent", version: "v1" },
  };
  const agents = await listPolicies(baseUrl, instanceId, "agent");
  let agent = agents.find((item) => item.policy_name === AGENT_POLICY_NAME);
  if (agent) {
    assertExistingPolicy(agent, {
      agent_id: agentPayload.agent_id,
      workspace_dir: agentPayload.workspace_dir,
      service_policy_id: service.policy_id,
      enabled: true,
    });
  } else if (apply) {
    agent = await managerRequest<PolicyRecord>(baseUrl, instanceId, "/config-effective/agent-policies/", {
      method: "POST",
      body: JSON.stringify(agentPayload),
    });
  }

  console.log(JSON.stringify({
    apply,
    status: agent ? "configured" : "agent_policy_pending",
    servicePolicyId: service.policy_id,
    agentPolicyId: agent?.policy_id || null,
    shardCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
