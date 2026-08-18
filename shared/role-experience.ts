import type { RoleHomeStatus, RoleHomeTaskStatus } from "./role-home";

export type RoleTaskStarter = {
  id: string;
  label: string;
  description: string;
  prompt: string;
  icon: "brief" | "chart" | "check" | "file" | "message" | "search" | "shield" | "target";
  attachmentRecommended?: boolean;
  confirmationRequired?: boolean;
};

export type RoleCapabilityPresentation = {
  id: string;
  label: string;
  icon: "customer" | "analysis" | "allocation" | "product" | "governance" | "operations" | "research" | "skill";
  taskIds: string[];
};

export type RoleExperience = {
  roleTemplate: string;
  maturity: "reference" | "operational" | "foundation";
  assistantLabel: string;
  description: string;
  summary: string;
  tasks: RoleTaskStarter[];
  taskSlots: string[][];
  capabilities: RoleCapabilityPresentation[];
};

const ROLE_EXPERIENCES: Record<string, RoleExperience> = {
  "wealth-manager": {
    roleTemplate: "wealth-manager",
    maturity: "reference",
    assistantLabel: "你的 AI 财富助理",
    description: "连接客户数据、产品知识和业务规则，辅助完成客户经营、资产配置与合规判断。",
    summary: "客户经营、资产配置与适当性判断",
    tasks: [
      {
        id: "WM-GT-01",
        label: "客户拜访准备",
        description: "汇总客户画像、持仓与沟通重点",
        prompt: "明天下午要拜访一位客户，请根据我负责的客户数据，准备一份访前简报和 3 至 5 条谈话要点。",
        icon: "brief",
      },
      {
        id: "WM-GT-02",
        label: "资产配置方案",
        description: "结合风险等级和资产结构形成配置建议",
        prompt: "请从我负责的客户中选择一位适合分析的客户，结合最新画像、持仓和当前产品数据，形成资产配置建议并说明排除项。",
        icon: "chart",
      },
      {
        id: "WM-GT-03",
        label: "核验现行政策",
        description: "仅采用当前有效的销售依据",
        prompt: "请根据当前有效的财富产品销售政策，说明为客户提供产品建议前必须完成哪些检查，并列出本次采用的制度版本。",
        icon: "file",
      },
      {
        id: "WM-GT-04",
        label: "适当性检查",
        description: "检查风险等级、产品匹配与销售规则",
        prompt: "请选择一位存在适当性风险的演示客户，核验风险测评、产品风险和销售状态，明确哪些建议必须阻断以及下一步如何处理。",
        icon: "shield",
      },
      {
        id: "WM-GT-05",
        label: "创建客户跟进",
        description: "根据当前分析创建客户跟进记录",
        prompt: "请从我负责的客户中选择一位近期需要跟进的客户，先核实客户情况并生成跟进草稿；确认信息合适后，再申请创建一条客户跟进记录。",
        icon: "check",
        confirmationRequired: true,
      },
      {
        id: "WM-GT-06",
        label: "产品到期经营",
        description: "识别近期到期客户并形成跟进计划",
        prompt: "请梳理未来 30 天产品到期的客户，按优先级给出跟进计划，并区分已核实信息和仍需补充的事项。",
        icon: "target",
      },
    ],
    taskSlots: [["WM-GT-01"], ["WM-GT-02"], ["WM-GT-06"], ["WM-GT-05"]],
    capabilities: [
      { id: "customer-operations", label: "客户经营", icon: "operations", taskIds: ["WM-GT-01", "WM-GT-06", "WM-GT-05"] },
      { id: "customer-analysis", label: "客户分析", icon: "customer", taskIds: ["WM-GT-01", "WM-GT-02"] },
      { id: "asset-allocation", label: "资产配置", icon: "allocation", taskIds: ["WM-GT-02"] },
      { id: "product-matching", label: "产品匹配", icon: "product", taskIds: ["WM-GT-02", "WM-GT-04"] },
      { id: "compliance-guard", label: "合规护航", icon: "governance", taskIds: ["WM-GT-03", "WM-GT-04"] },
    ],
  },
  "insurance-advisor": {
    roleTemplate: "insurance-advisor",
    maturity: "reference",
    assistantLabel: "你的 AI 保险顾问助理",
    description: "连接客户画像、产品考点和销售规则，辅助完成续保经营、保障分析与客户沟通。",
    summary: "客户续保、产品匹配与销售陪练",
    tasks: [
      { id: "IA-GT-01", label: "续保访前准备", description: "客户、车辆与保障情况梳理", prompt: "请从我负责的客户中选择一位近期需要续保的演示客户，准备访前简报，并列出需要进一步核实的信息。", icon: "brief" },
      { id: "IA-GT-02", label: "保障缺口分析", description: "结合客户事实匹配候选方案", prompt: "请根据一位演示客户的最新画像分析车险保障缺口，查询可用产品形成候选方向，并说明不适配项。", icon: "target" },
      { id: "IA-GT-03", label: "产品解释对比", description: "保障责任、限制与销售考点", prompt: "请从当前产品中选择两款适合对比的车险方案，说明保障差异、限制条件和客户沟通时必须讲清的考点。", icon: "search" },
      { id: "IA-GT-05", label: "销售对话陪练", description: "模拟异议并给出阶段反馈", prompt: "开始一次车险续保销售陪练。请扮演有价格异议的客户，在每轮对话后继续推进场景，结束时给出阶段评分和改进建议。", icon: "message" },
    ],
    taskSlots: [["IA-GT-01"], ["IA-GT-02"], ["IA-GT-03"], ["IA-GT-05"]],
    capabilities: [
      { id: "renewal-operations", label: "续保经营", icon: "operations", taskIds: ["IA-GT-01"] },
      { id: "needs-analysis", label: "需求分析", icon: "customer", taskIds: ["IA-GT-02"] },
      { id: "product-explanation", label: "产品讲解", icon: "product", taskIds: ["IA-GT-03"] },
      { id: "sales-coaching", label: "销售陪练", icon: "skill", taskIds: ["IA-GT-05"] },
      { id: "sales-compliance", label: "合规销售", icon: "governance", taskIds: ["IA-GT-02", "IA-GT-03"] },
    ],
  },
  "post-loan-risk-control": {
    roleTemplate: "post-loan-risk-control",
    maturity: "reference",
    assistantLabel: "你的 AI 风控助理",
    description: "连接企业贷后数据、风险知识和预警规则，辅助完成风险核查、诊断与跟踪。",
    summary: "贷后核查、预警诊断与风险处置",
    tasks: [
      { id: "RC-GT-01", label: "企业贷后核查", description: "贷款、评级与经营全景", prompt: "请从当前可访问的演示企业中选择一家，完成贷后全景核查，列出已核验事实、风险概览和缺失项。", icon: "brief" },
      { id: "RC-GT-02", label: "财务还款诊断", description: "识别趋势异常与待核验事项", prompt: "请选择一家存在异常信号的演示企业，结合财务报表和还款记录分析变化趋势，区分事实、风险判断和待核验事项。", icon: "chart" },
      { id: "RC-GT-04", label: "外部风险核验", description: "司法、舆情与经营异常", prompt: "请核验一家演示企业近期的司法、失信、经营异常和舆情信息，注明数据时间，并给出是否需要升级处置的建议。", icon: "search" },
      { id: "RC-GT-05", label: "综合预警分级", description: "规则触发、等级与人工复核", prompt: "请基于当前可用数据对一家演示企业完成综合预警分级，列出触发规则、证据缺口和需要人工复核的事项。", icon: "shield" },
    ],
    taskSlots: [["RC-GT-01"], ["RC-GT-02"], ["RC-GT-04"], ["RC-GT-05"]],
    capabilities: [
      { id: "post-loan-monitoring", label: "贷后监测", icon: "operations", taskIds: ["RC-GT-01"] },
      { id: "financial-diagnosis", label: "财务诊断", icon: "analysis", taskIds: ["RC-GT-02"] },
      { id: "external-verification", label: "外部核验", icon: "research", taskIds: ["RC-GT-04"] },
      { id: "warning-grading", label: "预警分级", icon: "governance", taskIds: ["RC-GT-05"] },
    ],
  },
  "credential-compliance": {
    roleTemplate: "credential-compliance",
    maturity: "reference",
    assistantLabel: "你的 AI 审核助理",
    description: "结合审核技能和材料处理能力，辅助完成要素提取、规则检查与疑点识别。",
    summary: "材料分类、要素提取与合规审核",
    tasks: [
      { id: "AU-GT-01", label: "案件材料受理", description: "分类材料并形成受理清单", prompt: "请整理我上传的演示案件材料，按材料类型分类，形成已受理、无法识别和待补充清单，并保留材料来源。", icon: "file", attachmentRecommended: true },
      { id: "AU-GT-02", label: "凭证要素提取", description: "提取字段并保留原文位置", prompt: "请从我上传的演示凭证中提取关键要素，保留页码和原文位置，并标记无法确认或相互矛盾的字段。", icon: "search", attachmentRecommended: true },
      { id: "AU-GT-03", label: "完整性与相关性审核", description: "识别缺件、错件与待补材料", prompt: "请按当前审核要求检查我上传的演示材料是否完整且与申请事项相关，按已提供、缺失、需补正三类输出清单。", icon: "check", attachmentRecommended: true },
      { id: "AU-GT-04", label: "现行规则核验", description: "采用当前有效审核规则", prompt: "请核验当前智能审核任务应采用的规则版本，说明现行依据，并明确排除的历史或未生效版本。", icon: "shield" },
      { id: "AU-GT-05", label: "一致性疑点审核", description: "核对材料并分级异常疑点", prompt: "请核对我上传的演示申请表、流水和财务材料的一致性，区分事实与判断，列出疑点证据和人工复核等级。", icon: "chart", attachmentRecommended: true },
      { id: "AU-GT-06", label: "人工复核闭环", description: "形成意见并创建复核任务", prompt: "请根据当前演示案件的审核事实形成审核意见草稿；如达到人工复核条件，先生成任务草稿，待我确认后再创建演示复核任务。", icon: "target" },
    ],
    taskSlots: [["AU-GT-01"], ["AU-GT-02"], ["AU-GT-03"], ["AU-GT-06", "AU-GT-05"]],
    capabilities: [
      { id: "material-intake", label: "材料受理", icon: "operations", taskIds: ["AU-GT-01"] },
      { id: "element-extraction", label: "要素提取", icon: "analysis", taskIds: ["AU-GT-02"] },
      { id: "material-review", label: "材料审核", icon: "governance", taskIds: ["AU-GT-03", "AU-GT-04"] },
      { id: "anomaly-review", label: "疑点审核", icon: "research", taskIds: ["AU-GT-05"] },
      { id: "human-review", label: "人工复核", icon: "operations", taskIds: ["AU-GT-06"] },
    ],
  },
  "investment-researcher": {
    roleTemplate: "investment-researcher",
    maturity: "reference",
    assistantLabel: "你的 AI 投研助理",
    description: "连接金融数据、研究工具和工作知识，辅助完成公司研究、财报复盘与事件跟踪。",
    summary: "证券研究、财报分析与市场跟踪",
    tasks: [
      { id: "IR-GT-01", label: "公司快速研究", description: "业务、经营质量与关键变量", prompt: "请对【股票名称或代码】做一次快速研究，先核实证券身份和数据时间，再说明业务、经营质量、关键变量和主要风险。", icon: "search" },
      { id: "IR-GT-02", label: "最新财报复盘", description: "现金流、盈利质量与预期差", prompt: "请复盘【公司名称】的最新财报，明确报告期间，重点检查现金流、盈利质量、预期差和需要继续跟踪的指标。", icon: "chart" },
      { id: "IR-GT-03", label: "公司同业比较", description: "同期间、同口径横向分析", prompt: "请对【公司一】与【公司二或同业组】做横向比较，先确认比较期间和指标口径，再分析经营质量、估值和风险。", icon: "target" },
      { id: "IR-GT-04", label: "估值风险核验", description: "估值位置、波动与失效条件", prompt: "请核验【股票名称或代码】的当前估值和风险指标，注明数据时间、指标口径与结论失效条件，不输出伪精确目标价。", icon: "shield" },
      { id: "IR-GT-05", label: "公告事件解读", description: "事实、影响路径与待验证项", prompt: "请解读【公司、公告或市场事件】，优先核验正式公告，区分已确认事实、可能影响和仍需验证的信息。", icon: "file" },
      { id: "IR-GT-06", label: "研究备忘跟踪", description: "沉淀结论、风险与跟踪动作", prompt: "请将当前研究整理为备忘草稿，列出证据、核心风险、失效条件和跟踪动作；确认后再申请创建演示研究跟踪任务。", icon: "check", confirmationRequired: true },
    ],
    taskSlots: [["IR-GT-01"], ["IR-GT-02"], ["IR-GT-05"], ["IR-GT-06", "IR-GT-03"]],
    capabilities: [
      { id: "company-research", label: "公司研究", icon: "research", taskIds: ["IR-GT-01"] },
      { id: "financial-analysis", label: "财报分析", icon: "analysis", taskIds: ["IR-GT-02"] },
      { id: "peer-comparison", label: "同业比较", icon: "allocation", taskIds: ["IR-GT-03"] },
      { id: "valuation-risk", label: "估值风控", icon: "governance", taskIds: ["IR-GT-04"] },
      { id: "event-tracking", label: "事件跟踪", icon: "operations", taskIds: ["IR-GT-05", "IR-GT-06"] },
    ],
  },
  "general-assistant": {
    roleTemplate: "general-assistant",
    maturity: "foundation",
    assistantLabel: "你的 AI 工作助理",
    description: "结合文件、知识和自定义技能，辅助完成日常材料处理与工作任务。",
    summary: "通用对话、文件处理与自定义 Skill",
    tasks: [
      { id: "GENERAL-START-01", label: "整理工作材料", description: "提炼重点与行动清单", prompt: "请帮我整理接下来提供的工作材料，输出关键结论、风险点和行动清单。", icon: "file", attachmentRecommended: true },
      { id: "GENERAL-START-02", label: "生成工作方案", description: "目标、步骤与交付物", prompt: "请根据我描述的目标生成一份可执行工作方案，列出步骤、输入、交付物和风险。", icon: "brief" },
      { id: "GENERAL-START-03", label: "检查已有内容", description: "发现缺口并给出修改建议", prompt: "请检查我接下来提供的内容，指出事实、逻辑、结构和执行层面的缺口，并给出修改建议。", icon: "check" },
      { id: "GENERAL-START-04", label: "试用自定义技能", description: "上传 Skill 后直接验证", prompt: "请使用我本轮选择的技能完成一个典型任务，并说明使用了哪些输入和步骤。", icon: "target" },
    ],
    taskSlots: [["GENERAL-START-01"], ["GENERAL-START-02"], ["GENERAL-START-03"], ["GENERAL-START-04"]],
    capabilities: [
      { id: "material-organization", label: "材料整理", icon: "operations", taskIds: ["GENERAL-START-01"] },
      { id: "work-planning", label: "方案规划", icon: "allocation", taskIds: ["GENERAL-START-02"] },
      { id: "content-review", label: "内容检查", icon: "governance", taskIds: ["GENERAL-START-03"] },
      { id: "custom-skill", label: "自定义技能", icon: "skill", taskIds: ["GENERAL-START-04"] },
    ],
  },
};

export function roleExperience(roleTemplate: unknown): RoleExperience {
  const key = String(roleTemplate || "general-assistant").trim();
  return ROLE_EXPERIENCES[key] || ROLE_EXPERIENCES["general-assistant"];
}

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  "investment-researcher": "投顾分析",
  "wealth-manager": "财富经理",
  "post-loan-risk-control": "风控经理",
  "credential-compliance": "审核专员",
  "insurance-advisor": "保险顾问",
  "general-assistant": "通用助手",
};

export function roleDisplayName(roleTemplate: unknown, roleName?: unknown): string {
  const name = String(roleName || "").trim();
  if (name) return name;
  return ROLE_DISPLAY_NAMES[String(roleTemplate || "").trim()] || "通用助手";
}

export function skillTrialPrompt(displayName: string): string {
  return `请使用「${String(displayName || "新上传技能").trim()}」完成一个典型任务。先确认技能已加载，再按技能流程执行并给出结果。`;
}

export function selectRoleHomeTaskIds(roleTemplate: unknown, statuses: RoleHomeTaskStatus[]): string[] {
  const experience = roleExperience(roleTemplate);
  const statusById = new Map(statuses.map((item) => [item.taskId, item.status]));
  const rank: Record<RoleHomeStatus, number> = { READY: 3, DEGRADED: 2, BLOCKED: 1 };
  return experience.taskSlots.map((slot) => {
    if (!slot.some((taskId) => statusById.has(taskId))) return slot.at(-1) || "";
    return [...slot].sort((left, right) => (
      rank[statusById.get(right) || "BLOCKED"] - rank[statusById.get(left) || "BLOCKED"]
    ))[0];
  }).filter(Boolean);
}
