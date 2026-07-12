import { createHmac } from "crypto";

function hmacKey(): string {
  return String(
    process.env.LOG_MESSAGE_HMAC_KEY
      || process.env.INTERNAL_API_KEY
      || process.env.JWT_SECRET
      || "employee-agent-local-development-log-key",
  );
}

export function redactLogPreview(raw: unknown): string {
  return String(raw || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/https?:\/\/[^\s]+/gi, "[URL]")
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[SECRET]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function privateMessageLogFields(raw: unknown): {
  messageLength: number;
  messageHmac: string;
  messagePreview?: string;
} {
  const message = String(raw || "");
  const fields: {
    messageLength: number;
    messageHmac: string;
    messagePreview?: string;
  } = {
    messageLength: Array.from(message).length,
    messageHmac: createHmac("sha256", hmacKey()).update(message).digest("hex"),
  };
  if (String(process.env.LOG_MESSAGE_PREVIEW_ENABLED || "").toLowerCase() === "true") {
    fields.messagePreview = redactLogPreview(message);
  }
  return fields;
}
