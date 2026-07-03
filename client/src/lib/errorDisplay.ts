export type DisplayErrorKind =
  | "forbidden"
  | "timeout"
  | "model"
  | "runtime"
  | "history"
  | "network"
  | "unknown";
type LegacyDisplayErrorKind = "openclaw";
type DisplayErrorContext = DisplayErrorKind | LegacyDisplayErrorKind;

export type DisplayError = {
  kind: DisplayErrorKind;
  title: string;
  detail: string;
};

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error || "");
}

function normalizeErrorContext(context: DisplayErrorContext): DisplayErrorKind {
  return context === "openclaw" ? "runtime" : context;
}

export function classifyDisplayError(error: unknown, context: DisplayErrorContext = "unknown"): DisplayError {
  const text = errorText(error);
  const lower = text.toLowerCase();
  const normalizedContext = normalizeErrorContext(context);

  if (/\b403\b|forbidden|unauthorized|permission|无权|权限/.test(lower)) {
    return {
      kind: "forbidden",
      title: "没有访问权限",
      detail: "当前账号没有访问该资源的权限。请确认登录账号、智能体归属或后台授权配置。",
    };
  }

  if (/abort|timeout|timed out|超时/.test(lower)) {
    return {
      kind: "timeout",
      title: "请求超时",
      detail: "服务响应时间过长。可能是 Agent Runtime、模型服务或网络链路暂时较慢。",
    };
  }

  if (/model|模型|unknown model|not exposed|provider/.test(lower) || normalizedContext === "model") {
    return {
      kind: "model",
      title: "模型配置不可用",
      detail: "当前模型或 provider 配置无法使用。请检查运行时默认模型、模型认证和 provider 名称。",
    };
  }

  if (/openclaw|gateway|ws|websocket|连接/.test(lower) || normalizedContext === "runtime") {
    return {
      kind: "runtime",
      title: "运行时连接异常",
      detail: "当前工作台暂时无法稳定连接 Agent Runtime。请查看健康诊断。",
    };
  }

  if (/history|session|conversation|历史|会话/.test(lower) || normalizedContext === "history") {
    return {
      kind: "history",
      title: "历史会话读取失败",
      detail: "历史记录暂时无法读取。若本地缓存存在，当前对话仍可继续使用。",
    };
  }

  if (/network|failed to fetch|load failed|fetch/.test(lower)) {
    return {
      kind: "network",
      title: "网络请求失败",
      detail: "浏览器到平台服务的请求失败。请检查网络、域名访问或服务状态。",
    };
  }

  return {
    kind: normalizedContext,
    title: "操作失败",
    detail: text || "发生未知错误，请稍后重试或查看健康诊断。",
  };
}

export function displayErrorMessage(error: unknown, context: DisplayErrorContext = "unknown") {
  const classified = classifyDisplayError(error, context);
  return classified.detail ? `${classified.title}：${classified.detail}` : classified.title;
}
