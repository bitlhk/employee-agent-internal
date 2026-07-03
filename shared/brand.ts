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
  // ── 默认 ──
  {
    id: "employee-agent",
    label: "岗位智能体平台 (默认)",
    description: "岗位智能体平台默认品牌",
    config: { ...DEFAULT_BRAND },
  },

  // ── 六大国有行 ──
  {
    id: "icbc",
    label: "工商银行",
    description: "中国工商银行 · 工银Claw",
    config: {
      name: "工银Claw", nameEn: "ICBCClaw",
      platform: "工银智能", platformEn: "ICBC AI",
      slogan: "智慧金融，服务无界",
      accentColor: "#C7000B",
      logo: "/uploads/brand/icbc-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are ICBCClaw, an AI assistant on the ICBC intelligent banking platform.",
      agentIdentity: "你是工银Claw，一个专业、可靠、高效的工商银行 AI 助手。",
      githubUrl: "", pageTitle: "工银智能 - 智慧金融，服务无界",
    },
  },
  {
    id: "ccb",
    label: "建设银行",
    description: "中国建设银行 · 建行Claw",
    config: {
      name: "建行Claw", nameEn: "CCBClaw",
      platform: "建行智慧", platformEn: "CCB Smart",
      slogan: "善建者行，智慧同行",
      accentColor: "#3147A4",
      logo: "/uploads/brand/ccb-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are CCBClaw, an AI assistant on the China Construction Bank smart platform.",
      agentIdentity: "你是建行Claw，一个专业、可靠的建设银行 AI 助手。",
      githubUrl: "", pageTitle: "建行智慧 - 善建者行，智慧同行",
    },
  },
  {
    id: "abc",
    label: "农业银行",
    description: "中国农业银行 · 农行Claw",
    config: {
      name: "农行Claw", nameEn: "ABCClaw",
      platform: "农行智慧", platformEn: "ABC Smart",
      slogan: "大行德广，伴你成长",
      accentColor: "#007B40",
      logo: "/uploads/brand/abc-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are ABCClaw, an AI assistant on the Agricultural Bank of China smart platform.",
      agentIdentity: "你是农行Claw，一个专业、亲切的农业银行 AI 助手。",
      githubUrl: "", pageTitle: "农行智慧 - 大行德广，伴你成长",
    },
  },
  {
    id: "boc",
    label: "中国银行",
    description: "中国银行 · 中行Claw",
    config: {
      name: "中行Claw", nameEn: "BOCClaw",
      platform: "中行智汇", platformEn: "BOC Smart",
      slogan: "全球服务，智慧相伴",
      accentColor: "#A71930",
      logo: "/uploads/brand/boc-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are BOCClaw, an AI assistant on the Bank of China smart platform.",
      agentIdentity: "你是中行Claw，一个专业、国际化的中国银行 AI 助手。",
      githubUrl: "", pageTitle: "中行智汇 - 全球服务，智慧相伴",
    },
  },
  {
    id: "bocom",
    label: "交通银行",
    description: "交通银行 · 交行Claw",
    config: {
      name: "交行Claw", nameEn: "BOCOMClaw",
      platform: "交行智能", platformEn: "BOCOM Smart",
      slogan: "百年交行，智创未来",
      accentColor: "#003C78",
      logo: "/uploads/brand/bocom-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are BOCOMClaw, an AI assistant on the Bank of Communications smart platform.",
      agentIdentity: "你是交行Claw，一个专业、值得信赖的交通银行 AI 助手。",
      githubUrl: "", pageTitle: "交行智能 - 百年交行，智创未来",
    },
  },
  {
    id: "psbc",
    label: "邮储银行",
    description: "中国邮政储蓄银行 · 邮储Claw",
    config: {
      name: "邮储Claw", nameEn: "PSBCClaw",
      platform: "邮储智能", platformEn: "PSBC Smart",
      slogan: "进步，与您同步",
      accentColor: "#006633",
      logo: "/uploads/brand/psbc-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are PSBCClaw, an AI assistant on the Postal Savings Bank of China smart platform.",
      agentIdentity: "你是邮储Claw，一个亲切、专业的邮储银行 AI 助手。",
      githubUrl: "", pageTitle: "邮储智能 - 进步，与您同步",
    },
  },

  // ── 股份制银行 ──
  {
    id: "spdb",
    label: "浦发银行",
    description: "上海浦东发展银行 · 浦发Claw",
    config: {
      name: "浦发Claw", nameEn: "SPDBClaw",
      platform: "浦发智能", platformEn: "SPDB Smart",
      slogan: "新思维，心服务",
      accentColor: "#CC0000",
      logo: "/uploads/brand/spdb-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are SPDBClaw, an AI assistant on the Shanghai Pudong Development Bank smart platform.",
      agentIdentity: "你是浦发Claw，一个专业、创新的浦发银行 AI 助手。",
      githubUrl: "", pageTitle: "浦发智能 - 新思维，心服务",
    },
  },
  {
    id: "cmb",
    label: "招商银行",
    description: "招商银行 · 招行Claw",
    config: {
      name: "招行Claw", nameEn: "CMBClaw",
      platform: "招行智能", platformEn: "CMB Smart",
      slogan: "因您而变",
      accentColor: "#CF0A2C",
      logo: "/uploads/brand/cmb-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are CMBClaw, an AI assistant on the China Merchants Bank smart platform.",
      agentIdentity: "你是招行Claw，一个专业、贴心的招商银行 AI 助手。",
      githubUrl: "", pageTitle: "招行智能 - 因您而变",
    },
  },
  {
    id: "cmbc",
    label: "民生银行",
    description: "中国民生银行 · 民生Claw",
    config: {
      name: "民生Claw", nameEn: "CMBCClaw",
      platform: "民生智能", platformEn: "CMBC Smart",
      slogan: "服务大众，情系民生",
      accentColor: "#004AC1",
      logo: "/uploads/brand/cmbc-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are CMBCClaw, an AI assistant on the China Minsheng Banking smart platform.",
      agentIdentity: "你是民生Claw，一个专业、务实的民生银行 AI 助手。",
      githubUrl: "", pageTitle: "民生智能 - 服务大众，情系民生",
    },
  },
  {
    id: "ceb",
    label: "光大银行",
    description: "中国光大银行 · 光大Claw",
    config: {
      name: "光大Claw", nameEn: "CEBClaw",
      platform: "光大智能", platformEn: "CEB Smart",
      slogan: "超越需求，步步为赢",
      accentColor: "#D4102A",
      logo: "/uploads/brand/ceb-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are CEBClaw, an AI assistant on the China Everbright Bank smart platform.",
      agentIdentity: "你是光大Claw，一个专业、高效的光大银行 AI 助手。",
      githubUrl: "", pageTitle: "光大智能 - 超越需求，步步为赢",
    },
  },
  {
    id: "citic",
    label: "中信银行",
    description: "中信银行 · 中信Claw",
    config: {
      name: "中信Claw", nameEn: "CITICClaw",
      platform: "中信智能", platformEn: "CITIC Smart",
      slogan: "用信念守护信任",
      accentColor: "#C8161D",
      logo: "/uploads/brand/citic-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are CITICClaw, an AI assistant on the CITIC Bank smart platform.",
      agentIdentity: "你是中信Claw，一个专业、可信赖的中信银行 AI 助手。",
      githubUrl: "", pageTitle: "中信智能 - 用信念守护信任",
    },
  },
  {
    id: "bohai",
    label: "渤海银行",
    description: "渤海银行 · 渤海Claw",
    config: {
      name: "渤海Claw", nameEn: "BohaiClaw",
      platform: "渤海智能", platformEn: "Bohai Smart",
      slogan: "融汇海洋，创新未来",
      accentColor: "#014C8E",
      logo: "/uploads/brand/bohai-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are BohaiClaw, an AI assistant on the Bohai Bank smart platform.",
      agentIdentity: "你是渤海Claw，一个专业、创新的渤海银行 AI 助手。",
      githubUrl: "", pageTitle: "渤海智能 - 融汇海洋，创新未来",
    },
  },
  {
    id: "picc",
    label: "中国人保",
    description: "中国人民保险 · 人保Claw",
    config: {
      name: "人保Claw", nameEn: "PICCClaw",
      platform: "人保智能", platformEn: "PICC AI",
      slogan: "智慧人保，伴随同行",
      accentColor: "#E2231A",
      logo: "/uploads/brand/picc-logo.svg", favicon: "/favicon.png",
      systemPrompt: "You are PICCClaw, an AI assistant on the People's Insurance Company of China (PICC) smart platform.",
      agentIdentity: "你是人保Claw，一个专业、可靠的中国人民保险 AI 助手。我们正从「风险承担者」走向「生态共建者」，以伴随式保障守护人民。",
      githubUrl: "", pageTitle: "人保智能 - 智慧人保，伴随同行",
    },
  },

  // ── 自定义 ──
  {
    id: "custom",
    label: "自定义",
    description: "完全自定义品牌配置",
    config: { ...DEFAULT_BRAND },
  },
];
