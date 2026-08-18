import { roleExperience } from "../../shared/role-experience";
import type {
  RoleHomeCapabilityStatus,
  RoleHomeRuntimeStatus,
  RoleHomeStatus,
  RoleHomeTaskStatus,
} from "../../shared/role-home";
import type { Skill } from "../../shared/types/skill";
import { evaluateWealthTaskReadiness, readinessCheck, type WealthGoldenTaskId } from "./governance/wealth-task-readiness";

export type RoleHomeConnectorState = {
  serverId: string;
  status: RoleHomeStatus;
};

function signal(status: RoleHomeStatus, code: string, readyMessage: string, unavailableMessage: string) {
  return readinessCheck(
    status,
    code,
    status === "READY" ? readyMessage : unavailableMessage,
    status === "READY" ? {} : { retryable: true },
  );
}

function connectorStatus(states: Map<string, RoleHomeStatus>, ids: string[]): RoleHomeStatus {
  if (ids.length === 0) return "READY";
  const values = ids.map((id) => states.get(id) || "BLOCKED");
  if (values.every((status) => status === "READY")) return "READY";
  if (values.some((status) => status === "READY" || status === "DEGRADED")) return "DEGRADED";
  return "BLOCKED";
}

function capabilityStatusLabel(status: RoleHomeStatus): string {
  if (status === "READY") return "已就绪";
  if (status === "DEGRADED") return "有限可用";
  return "暂不可用";
}

function aggregateTaskStatus(taskIds: string[], statuses: Map<string, RoleHomeStatus>): RoleHomeStatus {
  const values = taskIds.map((taskId) => statuses.get(taskId) || "BLOCKED");
  if (values.every((status) => status === "READY")) return "READY";
  if (values.every((status) => status === "BLOCKED")) return "BLOCKED";
  return "DEGRADED";
}

function genericTaskStatus(input: {
  taskId: string;
  requiredConnectorIds?: string[];
  connectors: Map<string, RoleHomeStatus>;
  knowledgeReady: boolean;
  skillReady: boolean;
  requiresKnowledge?: boolean;
  requiresSkill?: boolean;
}): RoleHomeTaskStatus {
  const connector = connectorStatus(input.connectors, input.requiredConnectorIds || []);
  const missing: string[] = [];
  if (connector !== "READY") missing.push("所需业务连接暂未全部就绪");
  if (input.requiresKnowledge && !input.knowledgeReady) missing.push("岗位知识暂未就绪");
  if (input.requiresSkill && !input.skillReady) missing.push("岗位技能暂未就绪");
  if (missing.length === 0) return { taskId: input.taskId, status: "READY" };
  return {
    taskId: input.taskId,
    status: "DEGRADED",
    reason: missing.join("；"),
    remediation: "当前仍可生成有限草稿，依赖恢复后可完成正式任务。",
  };
}

function wealthTaskStatus(input: {
  taskId: WealthGoldenTaskId;
  connectors: Map<string, RoleHomeStatus>;
  knowledgeReady: boolean;
  skillReady: boolean;
}): RoleHomeTaskStatus {
  const customer = connectorStatus(input.connectors, ["wealth_assistant_customer"]);
  const product = connectorStatus(input.connectors, ["wealth_assistant_product"]);
  const followup = connectorStatus(input.connectors, ["wealth_governance_demo"]);
  const ready = readinessCheck("READY", "ROLE_HOME_RUNTIME_READY", "当前岗位运行能力已就绪。");
  const knowledge = input.knowledgeReady
    ? readinessCheck("READY", "ROLE_KNOWLEDGE_READY", "岗位知识已就绪。")
    : readinessCheck(
        input.taskId === "WM-GT-03" ? "BLOCKED" : "DEGRADED",
        "ROLE_KNOWLEDGE_UNAVAILABLE",
        "当前有效的岗位知识暂未就绪。",
        { retryable: true },
      );
  const checks: Record<string, ReturnType<typeof readinessCheck>> = {
    identity: ready,
    knowledge,
    customerData: signal(customer, "CUSTOMER_DATA_STATUS", "客户数据已连接。", "客户数据连接暂未就绪。"),
    productData: signal(product, "PRODUCT_DATA_STATUS", "产品数据已连接。", "产品数据连接暂未就绪。"),
    policy: input.taskId === "WM-GT-03" && !input.knowledgeReady
      ? readinessCheck("BLOCKED", "CURRENT_POLICY_UNAVAILABLE", "现行制度依据暂未就绪。", { retryable: true })
      : ready,
    skill: input.skillReady
      ? ready
      : readinessCheck("DEGRADED", "ROLE_SKILL_UNAVAILABLE", "岗位技能暂未就绪。", { retryable: true }),
    capability: input.taskId === "WM-GT-05"
      ? signal(followup, "FOLLOWUP_CAPABILITY_STATUS", "客户跟进能力已连接。", "客户跟进写入能力暂未就绪。")
      : ready,
    approval: ready,
    idempotency: ready,
    receipt: ready,
    evidence: ready,
  };
  const decision = evaluateWealthTaskReadiness({ taskId: input.taskId, checks });
  return {
    taskId: input.taskId,
    status: decision.status,
    reason: decision.reasons[0],
    remediation: decision.remediation[0],
  };
}

const CONNECTOR_TASK_REQUIREMENTS: Record<string, Record<string, string[]>> = {
  "insurance-advisor": {
    "IA-GT-01": ["insurance_customer_profile"],
    "IA-GT-02": ["insurance_customer_profile", "insurance_product_exam_points"],
    "IA-GT-03": ["insurance_product_exam_points"],
    "IA-GT-05": ["insurance_product_exam_points"],
  },
  "post-loan-risk-control": {
    "RC-GT-01": ["post_loan_risk_data"],
    "RC-GT-02": ["post_loan_risk_data"],
    "RC-GT-04": ["post_loan_risk_data"],
    "RC-GT-05": ["post_loan_risk_data"],
  },
  "credential-compliance": {
    "AU-GT-02": ["credential_image_workspace"],
    "AU-GT-05": ["credential_image_workspace"],
    "AU-GT-06": ["wealth_governance_demo"],
  },
  "investment-researcher": {
    "IR-GT-01": ["wind_stock_data"],
    "IR-GT-02": ["wind_stock_data", "wind_financial_docs"],
    "IR-GT-03": ["wind_analytics_data"],
    "IR-GT-04": ["wind_stock_data"],
    "IR-GT-05": ["wind_financial_docs"],
    "IR-GT-06": ["wealth_governance_demo"],
  },
};

export function buildRoleHomeRuntimeStatus(input: {
  roleTemplate: string;
  connectors: RoleHomeConnectorState[];
  knowledgeReady: boolean;
  skills: Skill[];
  checkedAt?: string;
}): RoleHomeRuntimeStatus {
  const experience = roleExperience(input.roleTemplate);
  const connectors = new Map(input.connectors.map((item) => [item.serverId, item.status]));
  const skillReady = input.skills.some((skill) => skill.enabled && skill.state === "ready");
  const tasks = experience.tasks.map((task): RoleHomeTaskStatus => {
    if (experience.roleTemplate === "wealth-manager" && /^WM-GT-0[1-6]$/u.test(task.id)) {
      return wealthTaskStatus({
        taskId: task.id as WealthGoldenTaskId,
        connectors,
        knowledgeReady: input.knowledgeReady,
        skillReady,
      });
    }
    const requiredConnectorIds = CONNECTOR_TASK_REQUIREMENTS[experience.roleTemplate]?.[task.id] || [];
    return genericTaskStatus({
      taskId: task.id,
      requiredConnectorIds,
      connectors,
      knowledgeReady: input.knowledgeReady,
      skillReady,
      requiresKnowledge: experience.maturity === "reference",
      requiresSkill: experience.maturity === "reference",
    });
  });
  const taskStatuses = new Map(tasks.map((task) => [task.taskId, task.status]));
  const capabilities: RoleHomeCapabilityStatus[] = experience.capabilities.map((capability) => {
    const status = aggregateTaskStatus(capability.taskIds, taskStatuses);
    return {
      id: capability.id,
      label: capability.label,
      status,
      statusLabel: capabilityStatusLabel(status),
    };
  });
  return {
    roleTemplate: experience.roleTemplate,
    checkedAt: input.checkedAt || new Date().toISOString(),
    tasks,
    capabilities,
  };
}
