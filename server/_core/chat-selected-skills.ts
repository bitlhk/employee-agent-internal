const MAX_SELECTED_SKILLS = 3;

export type SkillSelectionMode = "manual" | "automatic";

export type AutomaticSkillMatch = {
  skillId: string;
  score: number;
  reason: "name" | "trigger" | "description" | "intent" | "session";
};

export type SkillSessionAffinity = {
  skillId: string;
  useCount: number;
  lastSelectedAt: Date | string;
};

export type SelectedRuntimeSkill = {
  id: string;
  name: string;
  description?: string;
  skillFile: string;
  runtimePath: string;
  sourceKind?: string;
  version?: string;
};

export type RuntimeSkillCandidate = {
  id?: unknown;
  enabled?: unknown;
  state?: unknown;
  name?: unknown;
  label?: unknown;
  displayName?: unknown;
  description?: unknown;
  sync?: { runtimePath?: unknown } | null;
  source?: { displayName?: unknown; description?: unknown } | null;
};

function normalizeSelectedSkillId(value: unknown): string {
  const skillId = String(value || "").trim();
  if (!skillId) return "";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(skillId)) return "";
  return skillId;
}

export function normalizeSelectedSkillIds(
  selectedSkillIds: unknown,
  legacySelectedSkillId?: unknown,
): { ok: true; skillIds: string[] } | { ok: false; error: string } {
  const rawValues = Array.isArray(selectedSkillIds)
    ? selectedSkillIds
    : legacySelectedSkillId == null
      ? []
      : [legacySelectedSkillId];
  if (rawValues.length > MAX_SELECTED_SKILLS) {
    return { ok: false, error: `每轮最多选择 ${MAX_SELECTED_SKILLS} 个技能` };
  }

  const skillIds: string[] = [];
  for (const rawValue of rawValues) {
    const rawSkillId = String(rawValue || "").trim();
    if (!rawSkillId) continue;
    const skillId = normalizeSelectedSkillId(rawSkillId);
    if (!skillId) return { ok: false, error: "所选技能标识无效" };
    if (!skillIds.includes(skillId)) skillIds.push(skillId);
  }
  return { ok: true, skillIds };
}

function compactMatchText(value: unknown): string {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function cjkBigrams(value: string): Set<string> {
  const out = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    const gram = value.slice(index, index + 2);
    if (/^[\p{Script=Han}a-z0-9]{2}$/u.test(gram)) out.add(gram);
  }
  return out;
}

function triggerTerms(description: string): string[] {
  const terms: string[] = [];
  for (const match of description.matchAll(/(?:触发词|关键词|触发条件)\s*[:：]\s*([^\n。；;]{2,120})/gi)) {
    terms.push(...String(match[1] || "").split(/[、,，/|]/));
  }
  return terms.map(compactMatchText).filter((term) => term.length >= 2);
}

function automaticSkillScore(query: string, name: string, description: string): Omit<AutomaticSkillMatch, "skillId"> | null {
  const compactQuery = compactMatchText(query);
  const compactName = compactMatchText(name).replace(/(?:技能|智能体|助手)$/u, "");
  if (compactQuery.length < 2 || compactName.length < 2) return null;

  if (compactQuery.includes(compactName) && compactName.length >= 3) {
    return { score: 120, reason: "name" };
  }
  if (compactName.includes(compactQuery) && compactQuery.length >= 3) {
    return { score: 115, reason: "name" };
  }

  for (const trigger of triggerTerms(description)) {
    if (compactQuery.includes(trigger) || (trigger.length >= 4 && trigger.includes(compactQuery))) {
      return { score: 110, reason: "trigger" };
    }
  }

  const compactDescription = compactMatchText(description);
  if (compactQuery.length >= 4 && compactDescription.includes(compactQuery)) {
    return { score: 92, reason: "description" };
  }

  const queryGrams = cjkBigrams(compactQuery);
  const nameGrams = cjkBigrams(compactName);
  const shared = [...queryGrams].filter((gram) => nameGrams.has(gram)).length;
  const hasActionIntent = /(?:请|帮我|我要|想要|开始|启动|使用|调用|运行|执行|生成|分析|对比|陪练|检查)/u.test(query);
  if (hasActionIntent && shared > 0) {
    const coverage = shared / Math.max(1, Math.min(queryGrams.size, nameGrams.size));
    if (coverage >= 0.34) return { score: 72 + Math.round(coverage * 10), reason: "intent" };
  }
  return null;
}

function isContinuationRequest(value: string): boolean {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text || text.length > 180) return false;
  return /(?:^|[，。！？,.!?\s])(?:继续|接着|再来|再做|再改|然后|下一步|按这个|基于这个|刚才|上面|前面|这个|那个|它|其|补充|调整|修改|优化|重试)(?:一下|下|吧|呢|看看|处理|分析|生成|执行|完善)?(?:$|[，。！？,.!?\s])/u.test(text)
    || /^(?:继续|接着|再|然后|下一步|按这个|基于这个|刚才|上面|前面|这个|那个|它|其)/u.test(text);
}

function affinityBoost(affinity: SkillSessionAffinity | undefined, nowMs: number): number {
  if (!affinity) return 0;
  const selectedAt = new Date(affinity.lastSelectedAt).getTime();
  if (!Number.isFinite(selectedAt)) return 0;
  const ageMs = Math.max(0, nowMs - selectedAt);
  if (ageMs > 24 * 60 * 60 * 1000) return 0;
  const recency = ageMs <= 30 * 60 * 1000 ? 8 : ageMs <= 4 * 60 * 60 * 1000 ? 5 : 2;
  const frequency = Math.min(5, Math.floor(Math.log2(Math.max(1, affinity.useCount))) + 1);
  return recency + frequency;
}

export function rankAutomaticSkillMatches(
  skills: RuntimeSkillCandidate[],
  userMessage: string,
  affinities: SkillSessionAffinity[] = [],
  now = new Date(),
): AutomaticSkillMatch[] {
  const affinityBySkill = new Map(affinities.map((item) => [item.skillId, item]));
  const continuation = isContinuationRequest(userMessage);
  const nowMs = now.getTime();
  const ranked = skills
    .filter((skill) => skill?.enabled === true && skill?.state === "ready" && String(skill?.sync?.runtimePath || "").trim())
    .map((skill) => {
      const skillId = String(skill?.id || "").trim();
      const name = String(
        skill?.source?.displayName || skill?.displayName || skill?.label || skill?.name || skillId,
      ).trim();
      const description = String(skill?.source?.description || skill?.description || "").trim();
      const semantic = automaticSkillScore(userMessage, name, description);
      const affinity = affinityBySkill.get(skillId);
      const boost = affinityBoost(affinity, nowMs);
      if (semantic) return skillId ? { skillId, score: semantic.score + boost, reason: semantic.reason } : null;
      if (continuation && affinity && boost > 0) {
        return { skillId, score: 76 + boost, reason: "session" as const };
      }
      return null;
    })
    .filter(Boolean)
    .sort((left, right) => right!.score - left!.score) as AutomaticSkillMatch[];
  return ranked;
}

export function selectAutomaticSkillMatch(
  skills: RuntimeSkillCandidate[],
  userMessage: string,
  affinities: SkillSessionAffinity[] = [],
  now = new Date(),
): AutomaticSkillMatch | null {
  const ranked = rankAutomaticSkillMatches(skills, userMessage, affinities, now);
  const best = ranked[0];
  if (!best || best.score < 75) return null;
  const runnerUp = ranked[1];
  if (runnerUp && runnerUp.score >= best.score - 10) return null;
  return best;
}

export function buildSelectedSkillsManifest(
  skills: SelectedRuntimeSkill[],
  userMessage: string,
  selectionMode: SkillSelectionMode = "manual",
): string {
  const skillLines = skills.flatMap((skill, index) => [
    `${index + 1}. selectedSkillId: ${skill.id}`,
    `   selectedSkillName: ${skill.name}`,
    skill.description
      ? `   selectedSkillDescription: ${skill.description.slice(0, 300)}`
      : "",
    `   selectedSkillFile: ${skill.skillFile}`,
  ]).filter(Boolean);
  const manual = selectionMode === "manual";
  return [
    manual ? "【本轮已由用户在输入框选择技能 Chip】" : "【本轮已由平台根据用户请求匹配技能】",
    `selectedSkillCount: ${skills.length}`,
    ...skillLines,
    manual
      ? "要求：本轮优先使用用户选择的技能；根据用户目标决定组合方式和执行顺序，不要搜索或安装外部技能。"
      : "要求：用户请求与该技能高度匹配，本轮优先加载并使用该技能；不要搜索或安装外部技能。",
    "请仅按平台给出的 selectedSkillFile 精确路径读取对应 SKILL.md；路径已由平台校验，不得再用 glob、list_files、find、bash 或其他工具搜索、定位或安装已选技能。",
    "读取 SKILL.md 成功后应立即按其中任务路由调用已授权业务工具，并只在明确需要时读取该技能目录内的 references/scripts/examples；不要一次性加载无关材料。",
    "如果用户输入已经足够启动技能，请直接进入执行流程；如果缺少必要参数，再简短追问。",
    "",
    `用户问题：${userMessage}`,
  ].join("\n");
}

export function buildEnterpriseSelectedSkillsManifest(
  skills: SelectedRuntimeSkill[],
  userMessage: string,
  selectionMode: SkillSelectionMode = "manual",
): string {
  const skillLines = skills.flatMap((skill, index) => [
    `${index + 1}. selectedSkillId: ${skill.id}`,
    `   selectedSkillName: ${skill.name}`,
    skill.description
      ? `   selectedSkillDescription: ${skill.description.slice(0, 300)}`
      : "",
  ]).filter(Boolean);
  const manual = selectionMode === "manual";
  return [
    manual ? "【本轮已由用户选择岗位技能】" : "【本轮已由平台匹配岗位技能】",
    `selectedSkillCount: ${skills.length}`,
    ...skillLines,
    manual
      ? "要求：优先使用用户选择的技能，并根据用户目标决定组合方式和执行顺序。"
      : "要求：用户请求与该技能高度匹配，本轮优先加载并使用该技能。",
    "请通过企业运行时原生 skill_tool 加载上述已授权技能；不要使用文件、命令行或搜索工具定位技能。",
    "如果技能材料引用当前运行时不存在的工具，请按当前已授权工具的等价语义完成任务；不要连续重试未知工具。",
    "加载后立即按技能任务路由调用已授权业务能力；如果缺少必要参数，再简短追问。",
    "",
    `用户问题：${userMessage}`,
  ].join("\n");
}
