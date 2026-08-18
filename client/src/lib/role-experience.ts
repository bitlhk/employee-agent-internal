export type RoleTaskStarter = {
  id: string;
  label: string;
  description: string;
  prompt: string;
  icon: "brief" | "chart" | "check" | "file" | "message" | "search" | "shield" | "target";
  requiredConnectorIds?: string[];
  attachmentRecommended?: boolean;
};

export type RoleExperience = {
  roleTemplate: string;
  maturity: "reference" | "operational" | "foundation";
  summary: string;
  tasks: RoleTaskStarter[];
};

const ROLE_EXPERIENCES: Record<string, RoleExperience> = {
  "wealth-manager": {
    roleTemplate: "wealth-manager",
    maturity: "reference",
    summary: "客户经营、资产配置与适当性判断",
    tasks: [
      {
        id: "WM-GT-01",
        label: "客户访前准备",
        description: "客户画像、持仓与谈话要点",
        prompt: "明天下午要拜访一位客户，请根据我负责的客户数据，准备一份访前简报和 3 至 5 条谈话要点。",
        icon: "brief",
        requiredConnectorIds: ["wealth_assistant_customer"],
      },
      {
        id: "WM-GT-02",
        label: "资产配置建议",
        description: "结合风险等级筛选适配方向",
        prompt: "请从我负责的客户中选择一位适合分析的客户，结合最新画像、持仓和当前产品数据，形成资产配置建议并说明排除项。",
        icon: "chart",
        requiredConnectorIds: ["wealth_assistant_customer", "wealth_assistant_product"],
      },
      {
        id: "WM-GT-03",
        label: "核验现行政策",
        description: "仅采用当前有效的销售依据",
        prompt: "请根据当前有效的财富产品销售政策，说明为客户提供产品建议前必须完成哪些检查，并列出本次采用的制度版本。",
        icon: "file",
        requiredConnectorIds: ["platform_tools"],
      },
      {
        id: "WM-GT-04",
        label: "适当性检查",
        description: "识别风险错配与测评过期",
        prompt: "请选择一位存在适当性风险的演示客户，核验风险测评、产品风险和销售状态，明确哪些建议必须阻断以及下一步如何处理。",
        icon: "shield",
        requiredConnectorIds: ["wealth_assistant_customer", "wealth_assistant_product", "platform_tools"],
      },
    ],
  },
  "insurance-advisor": {
    roleTemplate: "insurance-advisor",
    maturity: "reference",
    summary: "客户续保、产品匹配与销售陪练",
    tasks: [
      {
        id: "IA-GT-01",
        label: "续保访前准备",
        description: "客户、车辆与保障情况梳理",
        prompt: "请从我负责的客户中选择一位近期需要续保的演示客户，准备访前简报，并列出需要进一步核实的信息。",
        icon: "brief",
        requiredConnectorIds: ["insurance_customer_profile"],
      },
      {
        id: "IA-GT-02",
        label: "保障缺口分析",
        description: "结合客户事实匹配候选方案",
        prompt: "请根据一位演示客户的最新画像分析车险保障缺口，查询可用产品形成候选方向，并说明不适配项。",
        icon: "target",
        requiredConnectorIds: ["insurance_customer_profile", "insurance_product_exam_points"],
      },
      {
        id: "IA-GT-03",
        label: "产品解释对比",
        description: "保障责任、限制与销售考点",
        prompt: "请从当前产品中选择两款适合对比的车险方案，说明保障差异、限制条件和客户沟通时必须讲清的考点。",
        icon: "search",
        requiredConnectorIds: ["insurance_product_exam_points"],
      },
      {
        id: "IA-GT-05",
        label: "销售对话陪练",
        description: "模拟异议并给出阶段反馈",
        prompt: "开始一次车险续保销售陪练。请扮演有价格异议的客户，在每轮对话后继续推进场景，结束时给出阶段评分和改进建议。",
        icon: "message",
      },
    ],
  },
  "post-loan-risk-control": {
    roleTemplate: "post-loan-risk-control",
    maturity: "reference",
    summary: "贷后核查、预警诊断与风险处置",
    tasks: [
      {
        id: "RC-GT-01",
        label: "企业贷后核查",
        description: "贷款、评级与经营全景",
        prompt: "请从当前可访问的演示企业中选择一家，完成贷后全景核查，列出已核验事实、风险概览和缺失项。",
        icon: "brief",
        requiredConnectorIds: ["post_loan_risk_data"],
      },
      {
        id: "RC-GT-02",
        label: "财务还款诊断",
        description: "识别趋势异常与待核验事项",
        prompt: "请选择一家存在异常信号的演示企业，结合财务报表和还款记录分析变化趋势，区分事实、风险判断和待核验事项。",
        icon: "chart",
        requiredConnectorIds: ["post_loan_risk_data"],
      },
      {
        id: "RC-GT-04",
        label: "外部风险核验",
        description: "司法、舆情与经营异常",
        prompt: "请核验一家演示企业近期的司法、失信、经营异常和舆情信息，注明数据时间，并给出是否需要升级处置的建议。",
        icon: "search",
        requiredConnectorIds: ["post_loan_risk_data"],
      },
      {
        id: "RC-GT-05",
        label: "综合预警分级",
        description: "规则触发、等级与人工复核",
        prompt: "请基于当前可用数据对一家演示企业完成综合预警分级，列出触发规则、证据缺口和需要人工复核的事项。",
        icon: "shield",
        requiredConnectorIds: ["post_loan_risk_data", "platform_tools"],
      },
    ],
  },
  "credential-compliance": {
    roleTemplate: "credential-compliance",
    maturity: "operational",
    summary: "材料分类、要素提取与合规审核",
    tasks: [
      {
        id: "AUDIT-START-01",
        label: "材料完整性审核",
        description: "识别缺件、错件与待补材料",
        prompt: "请审核我上传的材料是否完整，按已提供、缺失、需补正三类输出清单，并说明判断依据。",
        icon: "check",
        attachmentRecommended: true,
      },
      {
        id: "AUDIT-START-02",
        label: "凭证要素提取",
        description: "提取关键字段并标记疑点",
        prompt: "请从我上传的凭证材料中提取关键要素，保留原文位置，并标记无法确认或相互矛盾的字段。",
        icon: "file",
        attachmentRecommended: true,
      },
      {
        id: "AUDIT-START-03",
        label: "流水异常分析",
        description: "识别异常交易与核验线索",
        prompt: "请分析我上传的流水材料，识别金额、频率、交易对手和时间上的异常，并形成待核验事项清单。",
        icon: "chart",
        attachmentRecommended: true,
      },
      {
        id: "AUDIT-START-04",
        label: "生成审核规则",
        description: "把业务要求转成检查清单",
        prompt: "请把我接下来提供的审核要求整理为可执行的检查规则，包含适用范围、必查项、拒绝条件和人工复核条件。",
        icon: "shield",
      },
    ],
  },
  "investment-researcher": {
    roleTemplate: "investment-researcher",
    maturity: "operational",
    summary: "证券研究、财报分析与市场跟踪",
    tasks: [
      { id: "INVEST-START-01", label: "公司快速研究", description: "经营、估值、趋势与风险", prompt: "请对【股票名称或代码】做一次快速研究，先给结论，再说明经营质量、估值、趋势和主要风险。", icon: "search" },
      { id: "INVEST-START-02", label: "最新财报复盘", description: "现金流、盈利质量与预期差", prompt: "请复盘【公司名称】的最新财报，重点检查现金流、盈利质量、预期差和需要继续跟踪的指标。", icon: "chart" },
      { id: "INVEST-START-03", label: "公司横向对比", description: "同业经营质量和估值比较", prompt: "请对【公司一】与【公司二】做横向比较，重点分析经营质量、估值、趋势和风险。", icon: "target" },
      { id: "INVEST-START-04", label: "市场事件解读", description: "政策或公告的业务影响", prompt: "请解读【政策、公告或市场事件】，区分已确认事实、可能影响和仍需核验的信息。", icon: "file" },
    ],
  },
  "general-assistant": {
    roleTemplate: "general-assistant",
    maturity: "foundation",
    summary: "通用对话、文件处理与自定义 Skill",
    tasks: [
      { id: "GENERAL-START-01", label: "整理工作材料", description: "提炼重点与行动清单", prompt: "请帮我整理接下来提供的工作材料，输出关键结论、风险点和行动清单。", icon: "file", attachmentRecommended: true },
      { id: "GENERAL-START-02", label: "生成工作方案", description: "目标、步骤与交付物", prompt: "请根据我描述的目标生成一份可执行工作方案，列出步骤、输入、交付物和风险。", icon: "brief" },
      { id: "GENERAL-START-03", label: "检查已有内容", description: "发现缺口并给出修改建议", prompt: "请检查我接下来提供的内容，指出事实、逻辑、结构和执行层面的缺口，并给出修改建议。", icon: "check" },
      { id: "GENERAL-START-04", label: "试用自定义技能", description: "上传 Skill 后直接验证", prompt: "请使用我本轮选择的技能完成一个典型任务，并说明使用了哪些输入和步骤。", icon: "target" },
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
