/**
 * 品牌配置 — 类型定义 + 默认值
 *
 * 优先级: DB system_configs (brand_*) > 环境变量 (BRAND_*) > 默认值
 * 默认值 = 当前岗位智能体平台硬编码值，不做任何配置时行为完全不变。
 */

export interface BrandConfig {
  /** 产品名（中文），如 "岗位智能体平台" */
  name: string;
  /** 产品名（英文），如 "Workforce Agent Platform" */
  nameEn: string;
  /** 平台名（中文），如 "岗位智能体平台" */
  platform: string;
  /** 平台名（英文），如 "Workforce Agent Platform" */
  platformEn: string;
  /** 标语 */
  slogan: string;
  /** 主题色 hex，如 "#9e1822" */
  accentColor: string;
  /** Logo 路径，如 "/images/workforce-agent.svg" */
  logo: string;
  /** Favicon 路径 */
  favicon: string;
  /** AI System Prompt（英文，平台级安全提示首句） */
  systemPrompt: string;
  /** Agent 身份自我介绍（中文，写入 SOUL.md） */
  agentIdentity: string;
  /** 开源仓库 URL */
  githubUrl: string;
  /** 页面 <title> */
  pageTitle: string;
}

/** 岗位智能体平台默认值 — 与当前硬编码完全一致 */
export const DEFAULT_BRAND: BrandConfig = {
  name: "岗位智能体平台",
  nameEn: "Workforce Agent Platform",
  platform: "岗位智能体平台",
  platformEn: "Workforce Agent Platform",
  slogan: "企业岗位智能体平台",
  accentColor: "#9e1822",
  logo: "/images/workforce-agent.svg",
  favicon: "/favicon.png",
  systemPrompt:
    "You are a professional enterprise AI agent on the Workforce Agent Platform.",
  agentIdentity:
    "你是岗位智能体平台中的岗位智能体，一个友好、专业、简洁的 AI 助手。",
  githubUrl: "https://github.com/bitlhk/employee-agent",
  pageTitle: "岗位智能体平台 - 企业岗位智能体平台",
};

/** system_configs 表中 brand 配置的 key 前缀 */
export const BRAND_CONFIG_PREFIX = "brand_";

/** BrandConfig 字段名 → system_configs key 的映射 */
export const BRAND_DB_KEYS: Record<keyof BrandConfig, string> = {
  name: "brand_name",
  nameEn: "brand_name_en",
  platform: "brand_platform",
  platformEn: "brand_platform_en",
  slogan: "brand_slogan",
  accentColor: "brand_accent_color",
  logo: "brand_logo",
  favicon: "brand_favicon",
  systemPrompt: "brand_system_prompt",
  agentIdentity: "brand_agent_identity",
  githubUrl: "brand_github_url",
  pageTitle: "brand_page_title",
};

const LEGACY_DEFAULT_BRAND_VALUES: Partial<Record<keyof BrandConfig, Set<string>>> = {
  name: new Set(["员工智能体", "岗位智能体", "Employee Agent"]),
  nameEn: new Set(["Employee Agent", "AI Agent Platform"]),
  platform: new Set(["员工智能体", "岗位智能体", "Employee Agent"]),
  platformEn: new Set(["Employee Agent", "AI Agent Platform"]),
  slogan: new Set(["企业 AI 员工平台", "Employee Agent", "AI Agent Platform"]),
  logo: new Set(["/images/employee-agent.svg"]),
  systemPrompt: new Set([
    "You are a professional enterprise AI agent on the Employee Agent Platform.",
    "You are Employee Agent, an enterprise AI assistant.",
    "You are Employee Agent, an enterprise AI assistant on the Employee Agent platform.",
  ]),
  agentIdentity: new Set([
    "你是员工智能体，一个友好、专业、简洁的 AI 助手。",
    "你是员工智能体平台中的员工智能体，一个友好、专业、简洁的 AI 助手。",
  ]),
  pageTitle: new Set([
    "Employee Agent",
    "Employee Agent - AI Agent Platform",
    "员工智能体 - 企业 AI 员工平台",
    "岗位智能体 - AI Agent Platform",
  ]),
};

function normalizeBrandDbValue(field: keyof BrandConfig, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (LEGACY_DEFAULT_BRAND_VALUES[field]?.has(trimmed)) return null;
  return trimmed;
}

/**
 * 从 DB 行 (key→value map) 合并出完整的 BrandConfig。
 * 未设置的字段 fallback 到 env → 默认值。
 */
export function mergeBrandConfig(
  dbValues: Record<string, string | null | undefined>
): BrandConfig {
  const result = { ...DEFAULT_BRAND };
  for (const [field, dbKey] of Object.entries(BRAND_DB_KEYS)) {
    const dbVal = dbValues[dbKey];
    if (dbVal !== undefined && dbVal !== null) {
      const normalized = normalizeBrandDbValue(field as keyof BrandConfig, dbVal);
      if (normalized) (result as any)[field] = normalized;
    }
  }
  return result;
}


// ══════════════════════════════════════════════════
// 品牌预设模板
// ══════════════════════════════════════════════════

export interface BrandPreset {
  id: string;
  label: string;
  description: string;
  config: BrandConfig;
}

export const BRAND_PRESETS: BrandPreset[] = [
  {
    id: "workforce-agent",
    label: "岗位智能体平台 (默认)",
    description: "岗位智能体平台默认品牌",
    config: { ...DEFAULT_BRAND },
  },
  {
    id: "custom",
    label: "自定义",
    description: "完全自定义品牌配置",
    config: { ...DEFAULT_BRAND },
  },
];
