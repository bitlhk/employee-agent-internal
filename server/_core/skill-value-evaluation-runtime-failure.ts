import { EvaluationCancelledError } from "finance-skill-eval";

export type SkillEvaluationRuntimeFailure = {
  message: string;
  code: string;
  retryable: boolean;
};

export function sanitizeSkillEvaluationRuntimeError(value: unknown): string {
  return String(value || "Runtime 未返回错误详情")
    .replace(/((?:api[_-]?key|token|secret|authorization|cookie)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 500);
}

function nestedString(value: unknown, ...pathParts: string[]): string {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return "";
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : "";
}

export function skillEvaluationRuntimeHttpFailure(
  status: number,
  raw: string,
): SkillEvaluationRuntimeFailure {
  let code = `HTTP_${status}`;
  let detail = "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    code = sanitizeSkillEvaluationRuntimeError(
      parsed.code || nestedString(parsed, "error", "code") || code,
    );
    detail = sanitizeSkillEvaluationRuntimeError(
      nestedString(parsed, "error", "message")
      || (typeof parsed.error === "string" ? parsed.error : "")
      || parsed.message
      || parsed.detail,
    );
  } catch {
    detail = sanitizeSkillEvaluationRuntimeError(raw.replace(/^data:\s*/gmu, ""));
  }
  return {
    message: `Runtime HTTP ${status} · ${code}${detail ? `：${detail}` : ""}`,
    code,
    retryable: [502, 503, 504].includes(status),
  };
}

export async function waitBeforeSkillEvaluationRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new EvaluationCancelledError("用户已取消本轮评测");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new EvaluationCancelledError("用户已取消本轮评测"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 1_500);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
