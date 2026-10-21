import { type RawData } from "ws";

export function wsOriginFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${url.host}`;
  } catch {
    return "http://127.0.0.1";
  }
}

export function asJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseJsonFrame(raw: RawData): Record<string, unknown> | null {
  try {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function pickErrorMessage(frame: unknown): string {
  const root = asJsonObject(frame);
  const body = asJsonObject(root.body);
  const delta = asJsonObject(body.delta);
  const details = asJsonObject(body.details);
  const raw = String(
    body?.message
      || body?.error
      || body?.content
      || body?.text
      || delta?.error
      || delta?.message
      || delta?.content
      || delta?.text
      || details.message
      || details.error
      || root.message
      || "jiuwenclaw runtime error"
  ).slice(0, 1000);
  if (/max(?:imum)? iterations?|iteration limit|达到.{0,8}(?:迭代|工具).{0,8}上限/i.test(raw)) {
    return "本轮联网检索未能在限定步骤内收敛。请缩小问题范围，或提供一个明确的原始网址后重试。";
  }
  return raw;
}
