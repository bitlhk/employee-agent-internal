export type SkillValueMetric = {
  id: string;
  label: string;
  description: string;
  baselineScore: number;
  targetScore: number;
  maxScore: number;
};

export type SkillValueCase = {
  caseId: string;
  name: string;
  taskPrompt: string;
  baselineLabel: string;
  targetLabel: string;
  baselineScore: number;
  targetScore: number;
  baselineExcerpt: string[];
  targetExcerpt: string[];
  targetAdvantages: string[];
};

export type SkillValueMethodStep = {
  id: string;
  label: string;
  description: string;
  role: string;
};

export type SkillValueEvaluationReport = {
  schemaVersion: "ea.skill-value-evaluation.v1";
  reportId: string;
  skillId: string;
  skillName: string;
  domain: string;
  statusLabel: string;
  statusTone: "positive" | "warning" | "neutral";
  evaluatedAt: string;
  targetVersion: string;
  comparisonVersions: string[];
  headline: string;
  summary: string;
  preference: {
    targetWins: number;
    comparisonCount: number;
    orderDisagreements: number;
    reviewerLabel: string;
  };
  metrics: SkillValueMetric[];
  improvements: Array<{
    title: string;
    before: string;
    after: string;
    value: string;
  }>;
  cases: SkillValueCase[];
  methodology: SkillValueMethodStep[];
  evidence: Array<{ label: string; value: string }>;
  limitations: string[];
};

const wealthManagerAssistantReport: SkillValueEvaluationReport = {
  schemaVersion: "ea.skill-value-evaluation.v1",
  reportId: "wealth-manager-assistant-2.1-professional-value-v1",
  skillId: "wealth-manager-assistant",
  skillName: "客户经理财富助手",
  domain: "财富管理",
  statusLabel: "专业价值信号明确",
  statusTone: "positive",
  evaluatedAt: "2026-08-29",
  targetVersion: "2.1 专业化候选",
  comparisonVersions: ["2.0.1", "无目标 Skill"],
  headline:
    "同一模型装载专业化 Skill 后，更能发现客户真实矛盾、形成组合方案并引导客户决策。",
  summary:
    "在访前诊断和正式产品推荐两类任务的四组匿名换序对比中，AI 财富专家均选择 2.1 专业化候选。评审关注专业判断、业务完整性、表达质量和可执行性，不以回答更长或技术字段更多作为优势。",
  preference: {
    targetWins: 4,
    comparisonCount: 4,
    orderDisagreements: 0,
    reviewerLabel: "AI 财富管理业务专家匿名 A/B 盲评",
  },
  metrics: [
    {
      id: "professional_fit",
      label: "专业判断",
      description: "能否从客户目标、资金期限和风险感受形成财富判断",
      baselineScore: 3,
      targetScore: 4,
      maxScore: 4,
    },
    {
      id: "structure_and_clarity",
      label: "结构清晰",
      description: "结论、依据、方案取舍和下一步是否容易理解",
      baselineScore: 4,
      targetScore: 4,
      maxScore: 4,
    },
    {
      id: "business_completeness",
      label: "业务完整",
      description: "是否覆盖会改变客户决策的事实、约束和方案取舍",
      baselineScore: 3.25,
      targetScore: 4,
      maxScore: 4,
    },
    {
      id: "actionability",
      label: "可执行性",
      description: "输出能否直接支持财富经理面谈和客户作出选择",
      baselineScore: 3,
      targetScore: 4,
      maxScore: 4,
    },
  ],
  improvements: [
    {
      title: "从资料复述到客户洞察",
      before: "核对基础资料、风险等级和一般服务需求",
      after: "优先识别拜访触发点、资金期限、可承受浮亏金额和目标优先级",
      value: "帮助财富经理把有限会面时间用在真正会改变配置结论的问题上。",
    },
    {
      title: "从产品罗列到组合先行",
      before: "先介绍产品风险等级、期限和产品属性",
      after: "先守住流动性底线，再形成稳健层和增值层，最后映射产品",
      value: "产品成为解决客户约束的工具，而不是为了销售再拼配置理由。",
    },
    {
      title: "从风险标签到真实风险感受",
      before: "围绕 C/R 等级说明适配关系",
      after: "进一步确认客户能够接受的浮亏金额及发生波动时的真实行为",
      value: "避免把风险测评标签机械等同于客户愿意承担的组合波动。",
    },
    {
      title: "从模板话术到决策引导",
      before: "说明 A 更稳健、B 适度增强",
      after: "让客户在控制短期波动与承担长期波动争取增值之间作出选择",
      value: "话术不只介绍方案，而是帮助客户表达真实偏好并推进下一步。",
    },
  ],
  cases: [
    {
      caseId: "WM-SKILL-EVAL-001",
      name: "授权客户访前简报",
      taskPrompt:
        "明天下午要拜访陈明（C005），请准备访前简报和三至五条谈话要点。",
      baselineLabel: "2.0.1 / 无目标 Skill",
      targetLabel: "2.1 专业化候选",
      baselineScore: 3.25,
      targetScore: 4,
      baselineExcerpt: [
        "确认本次拜访重点、近期资金安排与服务需求。",
        "结合 C4 风险承受能力，了解客户对市场波动的关注。",
        "核实是否存在持仓、产品到期或流动性安排。",
      ],
      targetExcerpt: [
        "这次见面最想先确认哪件事：到期资金安排、资产调整，还是其他近期目标？",
        "未来 6-12 个月是否有明确资金用途和用钱时间，需要保留多少流动性？",
        "若组合短期出现波动，可接受的浮亏金额是多少，会等待还是调整？",
        "收益、流动性和本金安全中，哪一项必须优先保证？",
      ],
      targetAdvantages: [
        "问题更少但信息增益更高",
        "从风险标签推进到金额化风险感受",
        "明确了本次面谈要形成什么判断",
      ],
    },
    {
      caseId: "WM-SKILL-EVAL-006",
      name: "条件满足后的正式产品推荐",
      taskPrompt:
        "陈明的风险测评有效，客户、持仓、现行制度和在售产品数据均已核验。请给出正式候选产品、配置理由、风险提示、排除项和客户沟通话术。",
      baselineLabel: "2.0.1 / 无目标 Skill",
      targetLabel: "2.1 专业化候选",
      baselineScore: 3.38,
      targetScore: 4,
      baselineExcerpt: [
        "方案 A 更稳健，方案 B 适度增强。",
        "P009 为高流动性底仓，P001 封闭期不可赎回。",
        "产品均已通过适当性校验，请客户自主决策。",
      ],
      targetExcerpt: [
        "先以 15 万元 P009 守住 20% 高流动性底线，323 天封闭的 P001 不计入流动性。",
        "方案 A 将更多资金放在中期稳健层；方案 B 降低封闭产品占比、增加长期波动暴露。",
        "您更偏向控制短期波动，还是愿意用更多长期资金承担波动、争取增值？",
      ],
      targetAdvantages: [
        "先组合约束、后映射产品",
        "方案金额闭合且正确处理封闭期流动性",
        "把产品差异转化为客户可以回答的决策问题",
      ],
    },
  ],
  methodology: [
    {
      id: "agent-skills",
      label: "Agent Skills",
      description: "将财富 SOP、参考资料和工具使用方法封装为可版本化 Skill。",
      role: "定义评测对象",
    },
    {
      id: "prompt-library",
      label: "金融任务 Prompt 库",
      description: "用固定的访前、配置和推荐任务，让各版本面对同一业务问题。",
      role: "统一测试题",
    },
    {
      id: "promptfoo",
      label: "Promptfoo",
      description:
        "在相同模型与数据条件下执行目标 Skill、旧版和无目标 Skill 对照。",
      role: "执行受控比较",
    },
    {
      id: "expert-review",
      label: "AI 财富专家盲评",
      description:
        "隐藏版本身份并交换 A/B 顺序，按专业和业务维度判断哪份更可用。",
      role: "评价专业增益",
    },
  ],
  evidence: [
    {
      label: "评测数据集",
      value: "wealth-manager-assistant-2.1-expert-calibration-v3",
    },
    { label: "业务场景", value: "访前诊断、正式产品推荐" },
    { label: "匿名对比", value: "4 组，包含 A/B 换序" },
    { label: "评审一致性", value: "目标版胜出 4/4，换序分歧 0" },
  ],
  limitations: [
    "当前结果是 AI 财富专家试点评审，不代表独立人类财富专家认证。",
    "该报告证明专业价值信号，不等同于候选版本已经完成生产发布验证。",
    "第一版为手动评测报告，尚未接入自动任务和自动发布流程。",
  ],
};

export const skillValueEvaluationReports: Record<
  string,
  SkillValueEvaluationReport
> = {
  [wealthManagerAssistantReport.skillId]: wealthManagerAssistantReport,
};

export function getSkillValueEvaluationReport(skillId?: string | null) {
  if (!skillId) return null;
  return skillValueEvaluationReports[skillId] || null;
}
