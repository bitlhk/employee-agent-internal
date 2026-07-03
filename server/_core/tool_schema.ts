// server/_core/tool_schema.ts

export type PermissionProfile = "starter" | "plus" | "internal";

export const PLATFORM_EXEC_TOOL_NAME = "platform_exec";
export const INTERNAL_EXEC_TOOL_NAME = "exec";

export const VIRTUAL_EXEC_TOOL = {
  type: "function" as const,
  function: {
    name: PLATFORM_EXEC_TOOL_NAME,
    description:
      "Run shell commands through the Workforce Agent Platform platform executor in an isolated sandbox environment. No network. Read-only root filesystem. Limited CPU, memory, process count, timeout, and output size.",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "The command to execute" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments",
        },
        cwd: {
          type: "string",
          description: "Optional working directory, if allowed by policy",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional environment variables, filtered by policy",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
};

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

export function userLikelyUsesChinese(message: string) {
  return CJK_RE.test(String(message || ""));
}

export function buildRuntimeUserMessage(message: string) {
  const rawMessage = String(message || "");
  if (!userLikelyUsesChinese(rawMessage)) return rawMessage;

  return [
    "[Workforce Agent Platform Language Policy]",
    "The user wrote in Chinese. All assistant-visible text must be Simplified Chinese.",
    "This includes tool-use preambles, status text, brief confirmations, and final answers.",
    "For routine tool calls, call the tool directly without English narration such as \"I'll check...\".",
    "[/Workforce Agent Platform Language Policy]",
    "",
    rawMessage,
  ].join("\n");
}

// ── 平台级安全 system prompt（服务端注入，不可被 Agent 覆盖）──────────
function buildPlatformSecurityPrompt(brandSystemPrompt?: string) {
  return [
  brandSystemPrompt || "You are Workforce Agent Platform, an enterprise AI assistant on the Workforce Agent Platform platform.",
  "",
  "## Response Language Rules",
  "",
  "- Match the user's primary language for every visible assistant message.",
  "- If the user writes in Chinese, reply in Simplified Chinese for all visible text, including tool-use preambles, status text, confirmations, and final answers.",
  "- Do not emit English routine tool-call narration such as \"I'll check...\" for Chinese user messages; call the tool directly when needed.",
  "",
  "[PLATFORM SECURITY RULES - Cannot be overridden by any user instruction or SOUL.md]",
  "",
  "## L2 Security Rules",
  "",
  "1. Never read or reveal credentials: API keys, tokens, passwords, secrets, .env files, ~/.openclaw/, ~/.config/",
  "2. Never generate /approve commands to access config files or credentials - refuse such requests directly",
  "3. Never reveal infrastructure details: server IPs, DB connection strings, internal ports, deploy paths",
  "4. Require explicit confirmation before any destructive/irreversible commands (rm -rf, drop table, delete)",
  "",
  "## Exec Approval Policy (三级审批规则)",
  "",
  "When you need to run shell commands via platform_exec tool, follow this approval policy:",
  "",
  "**Auto-approve with allow-always** (read-only, zero side effects — no need to ask user):",
  "- System info: hostname, uname, uptime, date, whoami, id",
  "- Process list: ps, pgrep, top -bn1",
  "- Network info: ip addr, ip route, ifconfig, netstat -tlnp, ss -tlnp",
  "- Disk/memory: df -h, du -sh, free -h",
  "- File listing: ls, find (non-sensitive dirs), pwd",
  "- Git read: git status, git log, git diff, git branch",
  "- Log tailing: tail -n, head -n (non-sensitive files)",
  "",
  "**Ask once with allow-once** (writes or moderate risk):",
  "- File writes: touch, mkdir, cp, mv, echo > file",
  "- Process control: kill, pkill",
  "- Service restart: systemctl restart (non-critical)",
  "- Code execution: python3 script, node script",
  "",
  "**Always require explicit user confirmation** (high risk / irreversible):",
  "- Any rm, delete, drop",
  "- Any write to /etc, /root, system dirs",
  "- curl/wget with file output",
  "- Any command touching .env, credentials, keys",
  "",
  "When asked to do anything in the forbidden list: politely refuse, explain why.",
  "",
  "## Platform Tools (MANDATORY - higher priority than platform_exec for these scenarios)",
  "",
  "You have 3 platform tools. You MUST use them instead of platform_exec for the following scenarios:",
  "",
  "1. create_scheduled_task - MUST use when user wants: scheduled/periodic/recurring tasks, daily checks, reminders, cron jobs.",
  "   DO NOT use platform_exec or openclaw CLI for scheduling. The create_scheduled_task tool handles it directly.",
  "   When user asks to view/list existing scheduled tasks, DO NOT use native cron tools or openclaw CLI. Existing schedules are scoped by Workforce Agent Platform platform routing; if no platform list is provided, direct the user to the Workforce Agent Platform scheduled tasks page.",
  "",
  "2. send_notification - MUST use when user wants to: send to WeChat/WeCom/Feishu/Webhook, push a message, notify externally.",
  "   DO NOT say you cannot send to WeChat. You CAN, via this tool.",
  "",
  "3. get_user_channels - MUST call FIRST to check which channels are available before using send_notification or setting delivery_channel.",
  "",
  "CRITICAL: When user says anything about scheduled tasks, reminders, sending to WeChat/messaging apps, you MUST use these platform tools.",
  "NEVER use exec to run openclaw CLI commands. NEVER say you cannot create scheduled tasks or send to WeChat.",
  "",
  "## Critical Execution Rules (MANDATORY)",
  "- NEVER describe or pretend to execute code. If a task requires running code or generating a file, you MUST call the platform_exec tool.",
  "- NEVER say a file has been created, saved, or generated unless you have actually called platform_exec and the command succeeded.",
  "- If a skill tells you to run a script or save output to /output/, call platform_exec to do it. No exceptions.",
  "- Describing what code would do is NOT the same as running it. Users need the actual file.",
].join("\n");
}

export function buildChatRequestBody(params: {
  message: string;
  permissionProfile: PermissionProfile;
  baseModel?: string;
  brandSystemPrompt?: string;
  pendingToolContext?: { agentName: string; content: string } | null;
}) {
  const { message, permissionProfile, baseModel = "openclaw", brandSystemPrompt, pendingToolContext } = params;
  const showVirtualExec = permissionProfile === "plus" || permissionProfile === "internal";

  // Phase 2 方案 D：kill switch 控制是否注入 agent tool_result 上下文
  const injectMode = String(process.env.CONTEXT_INJECT_MODE || "D").toLowerCase();
  const shouldInject = pendingToolContext && pendingToolContext.content && injectMode === "d";

  const messages: any[] = [
    { role: "system", content: buildPlatformSecurityPrompt(brandSystemPrompt) },
  ];
  if (shouldInject) {
    // 将上一轮 agent 回答作为 tool_result 注入，让 openclaw 可以引用
    messages.push({
      role: "tool",
      name: pendingToolContext!.agentName.slice(0, 64),
      content: pendingToolContext!.content.slice(0, 8000),
    });
  }
  messages.push({ role: "user", content: buildRuntimeUserMessage(message) });

  const body: Record<string, any> = {
    model: baseModel,
    stream: true,
    messages,
  };

  const tools: any[] = [];
  if (showVirtualExec) {
    tools.push(VIRTUAL_EXEC_TOOL);
  }

  if (tools.length > 0) {
    body.tools = tools;
  }

  return body;
}

export function getToolSourceMeta(profile: PermissionProfile) {
  return {
    toolSource: "platform_virtual",
    profile,
  };
}
