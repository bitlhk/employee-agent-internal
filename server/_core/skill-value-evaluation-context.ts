import { createHash } from "node:crypto";
import type {
  EvaluationContextAdapter,
  EvaluationScenarioSeed,
} from "finance-skill-eval";
import {
  createClawAdoption,
  createUser,
  getClawByAdoptId,
  getUserByEmail,
} from "../db";
import type { RuntimePrincipalV2 } from "./governance/contracts";
import { resolveRuntimePrincipalV2 } from "./governance/principal";
import {
  defaultCustomerDirectoryLoader,
  defaultCustomerPortfolioLoader,
  type CustomerDirectoryItemV1,
  type CustomerDirectoryResultV1,
  type CustomerPortfolioResultV1,
} from "./customer-context-tools";
import {
  executeCustomerProfileProviderTool,
  type CustomerProfileProviderToolResultV1,
} from "./customer-profile-mcp";
import { getSkillMcpRequirement } from "./role-templates";

type JsonObject = Record<string, unknown>;

type EvaluationCustomerCandidate = CustomerDirectoryItemV1 & {
  profile: JsonObject | null;
  portfolio: CustomerPortfolioResultV1 | null;
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function parseToolPayload(result: CustomerProfileProviderToolResultV1): JsonObject {
  try {
    return object(JSON.parse(result.content[0]?.text || "{}"));
  } catch {
    return {};
  }
}

function fieldMap(profile: JsonObject | null): Map<string, unknown> {
  const rows = Array.isArray(profile?.fields) ? profile.fields : [];
  return new Map(rows
    .map(object)
    .map(item => [String(item.path || ""), item.value] as const)
    .filter(([path]) => Boolean(path)));
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function appendFact(target: string[], label: string, value: unknown): void {
  if (value === null || value === undefined || value === "") return;
  const text = Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean).slice(0, 4).join("、")
    : String(value).trim();
  if (text) target.push(`${label}：${text.slice(0, 240)}`);
}

function amountText(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  if (amount >= 10_000) return `约${Number((amount / 10_000).toFixed(2))}万元`;
  return `约${Number(amount.toFixed(2))}元`;
}

function scenarioType(input: EvaluationCustomerCandidate, roleTemplate: string): string {
  if (roleTemplate === "insurance-advisor") {
    const fields = fieldMap(input.profile);
    return fields.get("insurance.renewalAt") ? "insurance_renewal" : "insurance_advisory";
  }
  if (input.portfolio?.maturities.length) return "wealth_maturity";
  if (Number(input.portfolio?.summary.availableCash || 0) > 0) return "wealth_allocation";
  return "wealth_previsit";
}

export function buildEaEvaluationScenarioSeed(
  input: EvaluationCustomerCandidate,
  roleTemplate: string,
): EvaluationScenarioSeed {
  const fields = fieldMap(input.profile);
  const promptFacts: string[] = [];
  const verificationFacts: string[] = [];
  const missingFacts: string[] = [];
  if (roleTemplate === "wealth-manager") {
    const availableCash = amountText(input.portfolio?.summary.availableCash);
    if (availableCash) promptFacts.push(`存在${availableCash}可用资金`);
    appendFact(promptFacts, "投资期限偏好", fields.get("preferences.investmentHorizon"));
    appendFact(promptFacts, "流动性要求", fields.get("preferences.liquidityNeeds"));
    appendFact(promptFacts, "已确认需求", fields.get("relationship.confirmedNeeds"));
    appendFact(verificationFacts, "客户风险等级", fields.get("risk.investmentRiskLevel"));
    appendFact(verificationFacts, "风险测评有效期", fields.get("risk.investmentRiskValidUntil"));
    appendFact(verificationFacts, "资产规模区间", fields.get("wealth.aumBand"));
    appendFact(verificationFacts, "总资产", amountText(input.portfolio?.summary.totalAssets));
    verificationFacts.push(`持仓记录数：${input.portfolio?.holdings.length || 0}`);
    verificationFacts.push(`到期记录数：${input.portfolio?.maturities.length || 0}`);
  } else {
    appendFact(promptFacts, "续保时间", fields.get("insurance.renewalAt"));
    appendFact(promptFacts, "已确认保障需求", fields.get("relationship.confirmedNeeds"));
    appendFact(verificationFacts, "当前保障摘要", fields.get("insurance.currentCoverageSummary"));
    appendFact(verificationFacts, "保障缺口", fields.get("insurance.protectionGaps"));
    appendFact(verificationFacts, "理赔风险摘要", fields.get("insurance.claimsRiskSummary"));
  }
  const profileStatus = firstText(input.profile?.status, "UNAVAILABLE");
  verificationFacts.unshift(`客户画像状态：${profileStatus}`);
  const requiredMissing = Array.isArray(input.profile?.missingRequiredFields)
    ? input.profile.missingRequiredFields.map(value => String(value).trim()).filter(Boolean)
    : [];
  if (requiredMissing.length) {
    missingFacts.push(`客户画像缺少：${requiredMissing.slice(0, 6).join("、")}`);
  }
  if (!promptFacts.length) promptFacts.push("需要完成一次客户访前准备");
  return {
    seedId: `customer-${input.customerId}`,
    title: `${input.displayName}${roleTemplate === "insurance-advisor" ? "保险服务" : "财富服务"}场景`,
    scenarioType: scenarioType(input, roleTemplate),
    subject: { ref: input.customerId, label: input.displayName },
    promptFacts: promptFacts.slice(0, 8),
    verificationFacts: verificationFacts.slice(0, 12),
    missingFacts: missingFacts.slice(0, 8),
    tags: [roleTemplate, input.businessDomain || "customer"],
  };
}

export function selectDiverseEvaluationCustomers(
  items: CustomerDirectoryItemV1[],
  maximumSeeds: number,
): CustomerDirectoryItemV1[] {
  const limit = Math.min(Math.max(maximumSeeds, 1), 6);
  const indexes = [
    Math.floor(items.length / 2),
    0,
    items.length - 1,
    Math.floor(items.length / 3),
    Math.floor((items.length * 2) / 3),
  ];
  const selected = new Map<string, CustomerDirectoryItemV1>();
  for (const index of indexes) {
    const item = items[index];
    if (item) selected.set(item.customerId, item);
    if (selected.size >= limit) break;
  }
  for (const item of items) {
    if (selected.size >= limit) break;
    selected.set(item.customerId, item);
  }
  return [...selected.values()];
}

type EaEvaluationContextLoaders = {
  directory(principal: RuntimePrincipalV2): Promise<CustomerDirectoryResultV1>;
  profile(principal: RuntimePrincipalV2, customerId: string): Promise<JsonObject | null>;
  portfolio(principal: RuntimePrincipalV2, customerId: string): Promise<CustomerPortfolioResultV1 | null>;
};

const defaultLoaders: EaEvaluationContextLoaders = {
  directory: principal => defaultCustomerDirectoryLoader({
    principal,
    query: "",
    scope: "demo_public",
    offset: 0,
    limit: 100,
  }),
  async profile(principal, customerId) {
    const result = await executeCustomerProfileProviderTool({
      principal,
      args: { customer_id: customerId },
      toolName: "get_customer_profile",
    });
    return parseToolPayload(result);
  },
  async portfolio(principal, customerId) {
    if (principal.roleTemplate !== "wealth-manager") return null;
    return defaultCustomerPortfolioLoader({ principal, subjectId: customerId });
  },
};

export function createEaSkillEvaluationContextAdapter(input: {
  principal: RuntimePrincipalV2;
  loaders?: EaEvaluationContextLoaders;
}): EvaluationContextAdapter {
  const loaders = input.loaders || defaultLoaders;
  return {
    adapterId: "ea-customer-context-v1",
    async load(request) {
      if (!Object.keys(getSkillMcpRequirement(request.skillId).servers).includes("customer_context")) {
        return null;
      }
      if (!["wealth-manager", "insurance-advisor"].includes(input.principal.roleTemplate)) {
        return null;
      }
      const directory = await loaders.directory(input.principal);
      const selected = selectDiverseEvaluationCustomers(directory.items, request.maximumSeeds);
      const candidates = await Promise.all(selected.map(async customer => {
        const [profile, portfolio] = await Promise.all([
          loaders.profile(input.principal, customer.customerId).catch(() => null),
          loaders.portfolio(input.principal, customer.customerId).catch(() => null),
        ]);
        return { ...customer, profile, portfolio };
      }));
      if (!candidates.length) return null;
      return {
        sourceLabel: "当前客户业务环境",
        mode: "host_enhanced",
        asOf: directory.generatedAt,
        capabilities: input.principal.roleTemplate === "wealth-manager"
          ? ["customer_directory", "customer_profile", "customer_portfolio"]
          : ["customer_directory", "customer_profile"],
        seeds: candidates.map(candidate => buildEaEvaluationScenarioSeed(
          candidate,
          input.principal.roleTemplate,
        )),
        redaction: "sanitized",
        metadata: {
          sourceKind: "customer_context",
          roleTemplate: input.principal.roleTemplate,
          availableCustomerCount: directory.total,
        },
      };
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export async function ensureEaSkillEvaluationContextPrincipal(input: {
  organization: string;
  roleTemplate: string;
}): Promise<RuntimePrincipalV2> {
  const organization = input.organization.trim() || "EA Skill Evaluation";
  const identity = digest(organization);
  const email = `skill-value-context+${identity}@local.linggan.invalid`;
  let user = await getUserByEmail(email);
  if (!user) {
    await createUser({
      name: "Skill Evaluation Context",
      email,
      loginMethod: "internal_evaluation",
      role: "user",
      accessLevel: "all",
      organization,
    });
    user = await getUserByEmail(email);
  }
  if (!user) throw new Error("无法创建 Skill 评测上下文用户");
  const adoptionId = `lgj-eval-context-${digest(`${organization}:${input.roleTemplate}`)}`;
  const agentId = `jiuwen_${adoptionId}`;
  let adoption = await getClawByAdoptId(adoptionId);
  if (!adoption) {
    await createClawAdoption({
      userId: user.id,
      adoptId: adoptionId,
      agentId,
      status: "active",
      permissionProfile: "internal",
      roleTemplate: input.roleTemplate,
      industry: input.roleTemplate.includes("insurance") ? "insurance" : "financial",
      runtime: "jiuwenswarm",
      ttlDays: 3650,
      entryUrl: `/workspace?adoptId=${encodeURIComponent(adoptionId)}`,
      expiresAt: null,
    });
    adoption = await getClawByAdoptId(adoptionId);
  }
  if (!adoption) throw new Error("无法创建 Skill 评测上下文实例");
  const resolved = await resolveRuntimePrincipalV2({
    adoption,
    user,
    sessionId: `skill-eval-context-${Date.now().toString(36)}`,
  });
  if (!resolved.complete) {
    throw new Error(`Skill 评测上下文身份不完整：${resolved.issues.join("、")}`);
  }
  return resolved.principal;
}
