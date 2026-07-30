const MAX_SELECTED_SKILLS = 3;

export type SelectedRuntimeSkill = {
  id: string;
  name: string;
  description?: string;
  skillFile: string;
  runtimePath: string;
  sourceKind?: string;
  version?: string;
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

export function buildSelectedSkillsManifest(
  skills: SelectedRuntimeSkill[],
  userMessage: string,
): string {
  const skillLines = skills.flatMap((skill, index) => [
    `${index + 1}. selectedSkillId: ${skill.id}`,
    `   selectedSkillName: ${skill.name}`,
    skill.description
      ? `   selectedSkillDescription: ${skill.description.slice(0, 300)}`
      : "",
    `   selectedSkillFile: ${skill.skillFile}`,
  ]).filter(Boolean);
  return [
    "【本轮已由用户在输入框选择技能 Chip】",
    `selectedSkillCount: ${skills.length}`,
    ...skillLines,
    "要求：本轮优先使用用户选择的技能；根据用户目标决定组合方式和执行顺序，不要搜索或安装外部技能。",
    "请按需加载各 selectedSkillFile 对应的 SKILL.md，并只在需要时读取相关 references/scripts/examples；不要一次性加载无关材料。",
    "如果用户输入已经足够启动技能，请直接进入执行流程；如果缺少必要参数，再简短追问。",
    "",
    `用户问题：${userMessage}`,
  ].join("\n");
}
