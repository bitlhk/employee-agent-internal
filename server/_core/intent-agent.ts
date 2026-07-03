/**
 * intent-agent.ts v2 — LLM 项目经理（替代意图识别）
 *
 * 不做意图分类/维度映射，让 LLM 以 tool calling 模式自主决定：
 *   - passthrough: 交给主聊天 Agent（普通对话）
 *   - schedule/send/channels: 平台操作
 *
 * 短消息（< 15 字且无关键词）直接 passthrough，不调 LLM。
 */
import type { StreamWriter } from "./stream-writer";
import { getBoundChannelsForAdopt } from "./cron/channel-binding-query";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = "https://api.deepseek.com";

function isMainChatProjectManagerEnabled(): boolean {
  return process.env.EA_MAIN_CHAT_PM_ENABLED === "1";
}

// ── 短消息快速过滤（不调 LLM）──
const PLATFORM_KEYWORDS = /定时|每天|每隔|提醒|发到|微信|飞书|企微|任务|渠道|技能|插件|工具包|帮我做个|帮我生成|协作/;

function needsProjectManager(msg: string): boolean {
  if (msg.length < 15 && !PLATFORM_KEYWORDS.test(msg)) return false;
  return true;
}

function normalizeHour(period: string, rawHour: number): number {
  let hour = rawHour;
  if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour = 12;
  if (hour < 0) hour = 0;
  if (hour > 23) hour = 23;
  return hour;
}

function formatTime(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function extractWeekdays(message: string): string[] {
  const match = message.match(/每周([一二三四五六日天和、,，\s]+)/);
  if (!match) return [];
  return [...match[1]].filter((ch) => /[一二三四五六日天]/.test(ch));
}

export function deriveScheduleTaskFromMessage(message: string): string {
  const cleaned = message
    .replace(/每天|每日|每周[一二三四五六日天]?|提醒我|定时|定期/g, "")
    .replace(/(凌晨|早上|上午|中午|下午|晚上)?\s*\d{1,2}\s*(?:点|时)(?:半)?/g, "")
    .replace(/并(发送|发|推送一下|推送下|推送|推|送)/g, "")
    .replace(/(发送|发|推送一下|推送下|推送|推|送)(到|给|去)?(我的)?(微信|飞书|企微|企业微信)?/g, "")
    .replace(/(微信|飞书|企微|企业微信)(发送|发|推送|推|送)?/g, "")
    .replace(/^(发送|发|推送|推|送)/g, "")
    .replace(/^[，,。.!！\s]+/g, "")
    .replace(/^(请|帮我|给我|麻烦|查一下|查询|看看|看下)\s*/g, "")
    .replace(/[，,。.!！\s]+/g, "")
    .trim();

  if (/天气/.test(message)) {
    return cleaned && /天气/.test(cleaned)
      ? `查询${cleaned}并生成简要结果`
      : "查询天气并生成简要结果";
  }

  return cleaned || message;
}

function quickScheduleAction(message: string): { tool: string; args: any } | null {
  if (/(查看|列出|有哪些|有啥|任务列表|当前|我的|你有哪些|你有啥).*?(?:定时任务|任务|cron|schedule)/i.test(message)) {
    return { tool: "list_schedules", args: {} };
  }
  return null;
}

// ── 项目经理 System Prompt ──
function buildPMSystemPrompt(
  boundChannels: string[],
): string {
  const channelList = boundChannels.length > 0
    ? boundChannels.map((channel) => `  - ${channel}`).join("\n")
    : "  - 暂无已绑定频道";

  const scheduleGuide = `create_schedule 参数必须使用结构化字段：
- name: 任务名称，例如 "天气推送"
- prompt: 每次定时真正要执行的任务，例如 "查询天气并生成简要结果"
- channel: 必填，只能从已绑定频道里选择 feishu/dingtalk；如果用户没说频道，不要猜，调用 create_schedule 时可以省略 channel，系统会追问。
- schedule.kind:
  - daily: 每天执行，必须填 time，如 "09:00"
  - weekly: 每周执行，必须填 time 和 weekdays，如 ["mon","wed","fri"] 或 ["一","三","五"]
  - once: 单次执行，必须填 runAt
  - interval: 间隔执行，必须填 intervalMinutes
  - cron: 高级 cron，必须填 cronExpr`;
  const scheduleChannelRule = "如果用户没说频道，不要猜测或默认选择频道；调用 create_schedule 时省略 channel，让执行器根据已绑定频道处理。";

  return `你是岗位智能体平台的项目经理。用户发来一条消息，你决定怎么处理。

你有以下工具可用：

1. passthrough — 普通对话、闲聊、简单问题、查天气、翻译等。交给主聊天 AI 处理。
2. create_schedule — 创建定时任务。
3. send_message — 立即发消息到某个渠道（飞书/钉钉）。
4. list_schedules — 查看已有定时任务。
5. delete_schedule — 删除定时任务。
6. create_skill — 生成一个用户自有技能。仅当用户明确要求"做一个技能/插件/工具包"时使用。

当前用户已绑定的推送频道：
${channelList}

决策原则：
- 简单问题（聊天、翻译、查天气）→ passthrough
- 定时/提醒/推送 → create_schedule 或 send_message。只能选择已绑定频道；${scheduleChannelRule}
- 生成技能/插件/工具包 → create_skill。生成的技能必须包含 SKILL.md；不要生成 child_process、eval、rm -rf、curl/wget 外部地址、删除 workspace 外文件等危险行为。
- 业务分析、风控评估、PPT、代码、股票等专业任务 → passthrough，由主聊天运行时和显式 Agent 工具处理。
- 如果没有已绑定频道但用户要创建定时推送，仍可调用 create_schedule，执行器会提示用户先去「频道」绑定。
- 不确定时 → passthrough（宁可不做平台操作也不误操作）

${scheduleGuide}`;
}

// ── Tool 定义 ──
function buildPMTools() {
  return [
  {
    type: "function" as const,
    function: {
      name: "passthrough",
      description: "普通对话，交给主聊天 AI 处理",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_schedule",
      description: "创建定时任务",
      parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "任务名称" },
              prompt: { type: "string", description: "每次定时执行时要交给 Agent 的指令" },
              schedule: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["daily", "weekly", "once", "interval", "cron"] },
                  time: { type: "string", description: "HH:mm，例如 09:00" },
                  weekdays: { type: "array", items: { type: "string" }, description: "weekly 使用，例如 [\"mon\",\"wed\",\"fri\"] 或 [\"一\",\"三\",\"五\"]" },
                  runAt: { type: "string", description: "once 使用，用户指定的执行时间" },
                  intervalMinutes: { type: "number", description: "interval 使用，间隔分钟数" },
                  cronExpr: { type: "string", description: "cron 使用，五段 cron 表达式" },
                },
                required: ["kind"],
              },
              channel: { type: "string", enum: ["feishu", "dingtalk"], description: "推送渠道。只能从当前用户已绑定频道里选；飞书用 feishu，钉钉用 dingtalk。" },
            },
            required: ["name", "prompt", "schedule"],
          },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_message",
      description: "立即发消息到指定渠道",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", enum: ["feishu", "dingtalk"] },
          content: { type: "string", description: "消息内容" },
        },
        required: ["channel", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_schedules",
      description: "查看已有的定时任务",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_schedule",
      description: "删除定时任务",
      parameters: {
        type: "object",
        properties: {
          task_name: { type: "string", description: "任务名称或关键词" },
        },
        required: ["task_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_skill",
      description: "根据用户需求生成一个可安装到当前智能体工作空间的技能。只在用户明确要求创建技能/插件/工具包时调用。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名称，至少 2 个字，例如 财报摘要助手" },
          description: { type: "string", description: "技能说明，一句话说明它能做什么" },
          files: {
            type: "array",
            description: "技能文件列表，必须包含 SKILL.md。路径必须是相对路径。",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "相对路径，例如 SKILL.md 或 scripts/run.py" },
                content: { type: "string", description: "文件内容" },
              },
              required: ["path", "content"],
            },
          },
        },
        required: ["name", "description", "files"],
      },
    },
  },
  ];
}

// ── 调用项目经理 LLM ──
async function callProjectManager(
  message: string,
  boundChannels: string[],
): Promise<{ tool: string; args: any }[]> {
  const systemPrompt = buildPMSystemPrompt(boundChannels);

  const resp = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      tools: buildPMTools(),
      temperature: 0,
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) return [{ tool: "passthrough", args: {} }];

  const data = await resp.json() as any;
  const choice = data?.choices?.[0];
  const toolCalls = choice?.message?.tool_calls;

  if (!toolCalls || toolCalls.length === 0) {
    // LLM 没调工具 → 当作 passthrough
    console.log("[PM-TOOLS] no tool_calls, LLM content:", String(choice?.message?.content || "").slice(0, 120));
    return [{ tool: "passthrough", args: {} }];
  }

  const mapped = toolCalls.map((tc: any) => ({
    tool: tc.function?.name || "passthrough",
    args: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
  }));
  console.log("[PM-TOOLS] LLM returned:", mapped.map((a: { tool: string; args: any }) => `${a.tool}(${JSON.stringify(a.args).slice(0, 80)})`).join(", "));
  return mapped;
}

function isScheduleManagementQuery(message: string): boolean {
  return /(?:查看|列出|有哪些|有啥|任务列表|当前|我的|你有哪些|你有啥).*?(?:定时任务|任务|cron|schedule)/i.test(message) ||
    /(?:删除|取消|关闭|停止).*?(?:定时任务|任务|cron|schedule)/i.test(message);
}

function isScheduleCreationLike(message: string): boolean {
  if (isScheduleManagementQuery(message)) return false;
  return /每天|每日|每周|每隔|提醒我|定时|定期|明天|后天|\d{1,2}\s*(?:点|时)(?:半)?/.test(message) &&
    /(?:发|发送|推送|提醒|通知|查|查询|搜|搜索|看看|看下)/.test(message);
}


export async function routeMessage(
  adoptId: string,
  message: string,
  writer: StreamWriter,
): Promise<boolean> {
  // Main chat no longer runs the EA-side project-manager router.
  // Platform cron/channel management remains available through explicit UI/API
  // surfaces, while natural-language scheduling is left to the runtime agent.
  if (!isMainChatProjectManagerEnabled()) {
    void adoptId;
    void message;
    void writer;
    return false;
  }

  const quickSchedule = quickScheduleAction(message);
  if (quickSchedule) {
    const { executePlatformIntent } = await import("./intent-executor");
    const quickScheduleType = quickSchedule.tool === "list_schedules" ? "schedule_list" : "schedule_create";
    await executePlatformIntent(adoptId, { type: quickScheduleType, ...quickSchedule.args }, writer);
    return true;
  }

  if (isScheduleCreationLike(message)) {
    console.log("[PM-L1] 定时创建交给 OpenClaw，走主聊天");
    return false;
  }

  const hasSkillOp = /(?:创建|生成|做|写|开发).*(?:技能|插件|工具包)|(?:技能|插件|工具包).*(?:创建|生成|做|写|开发)/.test(message);

  // 短消息快速通过，不调 LLM
  if (!needsProjectManager(message)) return false;

  // L1 门禁：主对话只允许平台操作进入 PM（定时任务/渠道/技能生成）。
  // 业务 Agent 自动推荐/自动派发已关闭，避免普通问题被误路由成 Agent 卡片。
  const hasScheduleManagementOp = isScheduleManagementQuery(message);
  const hasPlatformOp =
    hasScheduleManagementOp ||
    /(?:发|推|送)(?:到|给|去)?\s*(?:我的?)?\s*(?:微信|企微|飞书|webhook)/i.test(message) ||
    /(?:删除|取消|关闭|停止).*任务|任务列表|哪些.*任务|通知渠道|哪些渠道/.test(message) ||
    hasSkillOp;
  if (!hasPlatformOp) {
    console.log("[PM-L1] 未命中平台操作，走主聊天");
    return false;
  }
  console.log("[PM-L1] 命中平台操作关键字，进 PM");
  if (!DEEPSEEK_API_KEY) return false;

  // 调项目经理
  let actions: { tool: string; args: any }[];
  try {
    const boundChannels = (await getBoundChannelsForAdopt(adoptId)).map((channel) => channel.channelId);
    actions = await callProjectManager(message, boundChannels);
  } catch (e: any) {
    console.warn("[PM] project manager error:", e?.message?.slice(0, 80));
    return false; // 失败 → passthrough
  }

  // 全是 passthrough → 交给主聊天
  if (actions.every(a => a.tool === "passthrough")) return false;

  const platformOps = actions.filter(a => a.tool !== "passthrough");

  // 创建定时任务交给 OpenClaw 原生工具判断和执行，employee-agent 只保留查看/删除等管理动作。
  // 这样“每天10点发吗？”这类业务查询不会被平台层误建成定时任务。
  if (platformOps.some((op) => op.tool === "create_schedule")) {
    return false;
  }

  // 先执行平台操作（schedule/send 等）
  if (platformOps.length > 0) {
    const { executePlatformIntent } = await import("./intent-executor");
    for (const op of platformOps) {
      // 映射 tool name → intent type
      const typeMap: Record<string, string> = {
        create_schedule: "schedule_create",
        list_schedules: "schedule_list",
        delete_schedule: "schedule_delete",
        send_message: "send",
        create_skill: "skill_create",
      };
      const intent = { type: typeMap[op.tool] || op.tool, ...op.args };
      await executePlatformIntent(adoptId, intent, writer);
    }
  }

  writer.writeEnd();
  return true;
}

// ── 兼容旧接口（策略层保留）──
export type ApprovalPolicy = "auto" | "confirm" | "review";
export function getIntentPolicy(_type: string): ApprovalPolicy { return "auto"; }
export function scorePlatformIntent(_msg: string): number { return 0; }
export async function classifyIntent(_msg: string): Promise<any> { return { type: "passthrough" }; }
