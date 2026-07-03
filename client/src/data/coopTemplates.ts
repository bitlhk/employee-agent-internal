/**
 * 岗位智能体协作模板 — 内置模板（阶段 0：纯前端 const，不依赖 DB）
 *
 * 设计：
 *   - 每个模板定义 title / originMessage / memberPrompt / consolidationPrompt
 *   - 通过 renderVars() 做变量替换（不做 Mustache 级语法）
 *   - 选模板时整块重置 subtask（不走 CoopNew 原有的 prevOrigin 跟随逻辑）
 *
 * 后续阶段：
 *   - 阶段 1 加 lx_coop_templates 表支持个人/组织自建模板
 *   - 阶段 2 考虑 memberSystemHint 塞到 CoopChatBox 首条 message
 */

export type CoopTemplate = {
  id: string;
  name: string;
  icon: string;          // emoji
  description: string;   // 一行说明，Select 里展示
  title: string;          // 支持变量占位
  originMessage: string;  // 支持变量占位
  memberPrompt: string;   // 支持变量占位（分配给每个成员的 subtask 默认内容）
  consolidationPrompt: string; // 汇总 prompt 预设
};

/**
 * 变量替换 — 硬编码 7 个占位符
 *   {year} {week} {month} {date} {creator_name} {org_name} {group_name}
 * 不支持条件/循环，周数按 ISO 8601 算
 */
export function renderVars(
  tpl: string,
  vars: {
    creatorName?: string;
    orgName?: string;
    groupName?: string;
  }
): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = `${year}-${String(month).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const week = isoWeekNumber(now);

  return tpl
    .replaceAll("{year}", String(year))
    .replaceAll("{week}", String(week))
    .replaceAll("{month}", String(month))
    .replaceAll("{date}", date)
    .replaceAll("{creator_name}", vars.creatorName || "发起人")
    .replaceAll("{org_name}", vars.orgName || "本组织")
    .replaceAll("{group_name}", vars.groupName || "团队");
}

function isoWeekNumber(d: Date): number {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}

export const COOP_TEMPLATES: CoopTemplate[] = [
  {
    id: "blank",
    name: "空白",
    icon: "",
    description: "从零开始，什么模板都不套",
    title: "",
    originMessage: "",
    memberPrompt: "",
    consolidationPrompt: "",
  },
  {
    id: "weekly-report",
    name: "周报收集",
    icon: "",
    description: "按「场景 / 动作 / 效果」收集团队周报",
    title: "{year}-W{week} {group_name} 周报",
    originMessage:
      "本协作用于收集 {group_name} 本周工作周报。每位成员请按「场景 / 动作 / 效果」三段式提交，优先使用量化指标（数字、百分比、具体文件名或项目名）。最终将按人员分组整合为一份团队汇总周报。",
    memberPrompt: `请帮我整理本周的工作汇报，按以下格式输出：

### 本周工作
1. **场景**：xxx（业务背景或项目上下文）
   **动作**：做了什么（具体动作，不要用"参与""配合"这类模糊词）
   **效果**：产出物或量化指标

### 下周计划
（1-3 条重点）

### 风险/阻碍
（没有就写"无"）

**硬性规则**：
- 严禁"努力""积极配合""深入推进"类套话
- 每条必须带数字或具体文件名/项目名
- 控制在 300 字以内

我这周的素材（未整理）：
{{ 在此粘贴你这周做的事，列表式或流水账都行，AI 会帮你结构化 }}`,
    consolidationPrompt:
      "按人员分组输出每个人的「场景 / 动作 / 效果」结构。篇末追加一段全组洞察：关键量化指标 3 条、本周风险或阻碍、下周重点共识（≤3 条）。markdown 格式，直接从正文开始不加开场白。",
  },
  {
    id: "project-retro",
    name: "项目复盘",
    icon: "",
    description: "STAR 框架收集项目成员视角，汇总成 DO/DON'T 清单",
    title: "{group_name} 项目复盘 · {date}",
    originMessage:
      "本次复盘围绕 [请在此填入具体项目名] 展开。每位成员按 STAR 框架（Situation 情景 / Task 目标 / Action 动作 / Result 结果）提交个人视角，重点回答：哪些做对了可以复用？哪些没做好下次要避免？汇总时将按 DO / DON'T 两类沉淀成下次可迁移的经验。",
    memberPrompt: `请用 STAR 框架整理我在本项目中的参与：

### Situation（情景）
项目背景 + 我负责的部分

### Task（目标）
预期要达成什么（KPI / 交付物 / 时间节点）

### Action（动作）
我具体做了什么关键动作（3-5 条，避免笼统）

### Result（结果）
量化结果 + 与原目标对比（好于预期 / 达到 / 未达成）

### 可复用经验
1. **下次可复用**：具体到方法/工具/流程
2. **下次要避免**：具体到什么决策或动作

**规则**：每个 Action 和 Result 都要有具体数据；不写"团队合作很好"类概括。

我的素材：
{{ 粘贴你记得的细节：时间节点、交付物、关键决策、遇到的坑 }}`,
    consolidationPrompt:
      "合并为一份完整复盘报告：① 开头 1 段项目总体评价（含关键数字）；② 中间按 DO / DON'T 两列汇总全组成员的经验，每条注明来源成员；③ 末尾「下次可迁移 Checklist」（3-5 条可直接套用到下个项目的方法）。避免重复，合并相似观点。",
  },
  {
    id: "brainstorm",
    name: "头脑风暴",
    icon: "",
    description: "发散议题收集想法，汇总为 3-4 个方向",
    title: "{date} {group_name} 头脑风暴",
    originMessage:
      "围绕议题 [请在此替换为具体议题] 展开头脑风暴。每人提交 3-5 条想法即可，重发散轻完善、允许疯狂一点的点子。最终汇总将归类为 3-4 个方向，每个方向推出最可行的 1-2 条作为首选行动。",
    memberPrompt: `围绕上述议题，帮我快速梳理想法：

- 生成 5 条发散思路，每条一句话点子 + 可能的第一步行动
- 允许"疯狂一点"的想法，不要过度完美主义
- 每条后附一个标签：【可行】/【探索】/【激进】

我的初步想法（未组织）：
{{ 粘贴你的原始想法，关键词就行，AI 会帮你展开 }}`,
    consolidationPrompt:
      "将所有想法聚类成 3-4 个方向；每个方向内部合并重复点子、按可行性排序；每个方向推荐 1-2 条首选行动 + 选它的理由；最后给一段综合推荐：哪个方向最值得先试？为什么？",
  },
];

export function getTemplateById(id: string): CoopTemplate | undefined {
  return COOP_TEMPLATES.find((t) => t.id === id);
}
