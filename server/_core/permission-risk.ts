export type PermissionRiskLevel = "low" | "medium" | "high";

export type PermissionRisk = {
  riskLevel: PermissionRiskLevel;
  reasonCode: string;
  reasonText: string;
  allowAlways: boolean;
};

const HIGH_RISK_COMMAND = /(?:^|[;&|\s])(?:sudo\b|su\s+-|rm\s+(?:-[a-z]*f[a-z]*\s+)?(?:\/|~|\.\.)|mkfs\b|fdisk\b|parted\b|dd\s+if=|shutdown\b|reboot\b|poweroff\b|chmod\s+(?:-R\s+)?777\b|chown\s+-R\b)|(?:curl|wget)[^\n|;&]*\|\s*(?:ba)?sh\b/i;
const SECRET_OR_EXTERNAL = /(?:api[_-]?key|access[_-]?token|private[_-]?key|password|passwd|secret)|https?:\/\//i;

function hasAlwaysOption(options: Array<{ label?: string; value?: string }> | undefined): boolean {
  return Boolean(options?.some((option) => /^(?:allow[_ -]?always|总是允许|始终允许)$/i.test(
    String(option.value || option.label || "").trim(),
  )));
}

export function classifyPermissionRisk(input: {
  toolName?: unknown;
  command?: unknown;
  options?: Array<{ label?: string; value?: string }>;
}): PermissionRisk {
  const toolName = String(input.toolName || "").trim().toLowerCase();
  const command = String(input.command || "").normalize("NFKC").trim();
  const runtimeAllowsPersistence = hasAlwaysOption(input.options);

  if (HIGH_RISK_COMMAND.test(command)) {
    return {
      riskLevel: "high",
      reasonCode: "destructive_command",
      reasonText: "命令可能修改系统或造成不可逆影响，每次都需要确认",
      allowAlways: false,
    };
  }
  if (/(?:send|notify|webhook|email|mail|upload|publish|deploy|external)/i.test(toolName)
      || SECRET_OR_EXTERNAL.test(command)) {
    return {
      riskLevel: "high",
      reasonCode: "external_delivery",
      reasonText: "操作可能向外部服务发送数据，每次都需要确认",
      allowAlways: false,
    };
  }
  if (/(?:bash|shell|exec|terminal|write|edit|create|move|copy|delete|remove)/i.test(toolName)
      || Boolean(command)) {
    return {
      riskLevel: "medium",
      reasonCode: "workspace_change",
      reasonText: "操作可能执行命令或修改工作区内容",
      allowAlways: runtimeAllowsPersistence,
    };
  }
  if (/(?:read|list|search|find|grep|get|status|query|inspect)/i.test(toolName)) {
    return {
      riskLevel: "low",
      reasonCode: "read_only",
      reasonText: "操作以读取和查询为主",
      allowAlways: runtimeAllowsPersistence,
    };
  }
  return {
    riskLevel: "medium",
    reasonCode: "runtime_confirmation",
    reasonText: "运行时无法确认该工具的完整影响范围",
    allowAlways: runtimeAllowsPersistence,
  };
}
