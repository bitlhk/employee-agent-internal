import { createHash } from "crypto";
import { recordAuditBestEffort } from "./audit-events";
import {
  dataGuardrailMode,
  protectExternalText,
  type SensitiveDataType,
} from "./data-guardrail";

export type ToolEgressChannel =
  | "custom_mcp"
  | "mcp_adapter"
  | "a2a"
  | "managed_browser"
  | "jiuwen_pre_tool";

export type ToolEgressDecision = {
  ok: boolean;
  action: "allow" | "monitor" | "block";
  error?: string;
  types: SensitiveDataType[];
  reasonCodes: string[];
  payloadBytes: number;
  payloadHash: string;
};

export type ToolEgressInput = {
  channel: ToolEgressChannel;
  payload: unknown;
  adoptId?: string | null;
  toolName?: string | null;
  destinationUrl?: string | null;
  destinationTrust?: "platform" | "user" | "unknown";
};

const SECRET_TYPES = new Set<SensitiveDataType>([
  "private_key",
  "credential",
]);
const PERSONAL_DATA_TYPES = new Set<SensitiveDataType>([
  "cn_id_card",
  "cn_phone",
  "bank_card",
]);
const URL_CREDENTIAL_NAME_RE =
  /^(?:api[-_]?key|access[-_]?token|auth[-_]?token|bearer|client[-_]?secret|password|passwd|secret|token)$/i;
const MAX_URL_QUERY_CHARS = 4_096;
const MAX_URL_QUERY_VALUE_CHARS = 2_048;

function stablePayload(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.keys(item as Record<string, unknown>)
        .sort()
        .reduce((result: Record<string, unknown>, key) => {
          result[key] = (item as Record<string, unknown>)[key];
          return result;
        }, {});
    });
    return serialized === undefined ? String(value ?? "") : serialized;
  } catch {
    return String(value ?? "");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function destinationHost(rawUrl?: string | null): string | null {
  try {
    return rawUrl ? new URL(rawUrl).host : null;
  } catch {
    return null;
  }
}

function splitCsv(raw: string | undefined): string[] {
  return String(raw || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
}

function isTrustedDestination(input: ToolEgressInput): boolean {
  if (input.destinationTrust === "platform") return true;
  const host = destinationHost(input.destinationUrl)?.toLowerCase();
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "");
  return splitCsv(process.env.EA_TOOL_EGRESS_TRUSTED_HOSTS).some(entry =>
    entry === host || entry === hostname || (entry.startsWith(".") && hostname.endsWith(entry))
  );
}

function inspectDestinationUrl(rawUrl?: string | null): {
  hasCredential: boolean;
  queryTooLarge: boolean;
} {
  if (!rawUrl) return { hasCredential: false, queryTooLarge: false };
  try {
    const url = new URL(rawUrl);
    let decodedQueryChars = 0;
    let largestValueChars = 0;
    let hasCredential = Boolean(url.username || url.password);
    for (const [name, value] of url.searchParams.entries()) {
      decodedQueryChars += Array.from(name).length + Array.from(value).length;
      largestValueChars = Math.max(largestValueChars, Array.from(value).length);
      if (
        URL_CREDENTIAL_NAME_RE.test(name) &&
        Array.from(value.trim()).length >= 6 &&
        !isCredentialPlaceholder(`${name}=${value}`)
      ) {
        hasCredential = true;
      }
    }
    return {
      hasCredential,
      queryTooLarge:
        decodedQueryChars > MAX_URL_QUERY_CHARS ||
        largestValueChars > MAX_URL_QUERY_VALUE_CHARS,
    };
  } catch {
    return { hasCredential: false, queryTooLarge: false };
  }
}

function isCredentialPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /(?:your|example|sample)[_-]?(?:api[_-]?key|token|password)/i.test(
      normalized
    ) ||
    /(?:replace|change)[_-]?me/i.test(normalized) ||
    /(?:<[^>]+>|\$\{[^}]+\})/.test(value)
  );
}

export function evaluateToolEgress(
  input: ToolEgressInput
): ToolEgressDecision {
  const payload = stablePayload(input.payload);
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const protectedPayload = protectExternalText(payload, {
    mode: dataGuardrailMode(),
    requireBankCardContext: true,
  });
  const urlInspection = inspectDestinationUrl(input.destinationUrl);
  const hasSecret =
    protectedPayload.detections.some(
      detection =>
        SECRET_TYPES.has(detection.type) &&
        !isCredentialPlaceholder(
          payload.slice(detection.start, detection.end)
        )
    ) ||
    urlInspection.hasCredential;
  const hasPersonalData = protectedPayload.detections.some(detection =>
    PERSONAL_DATA_TYPES.has(detection.type)
  );
  const trustedDestination = isTrustedDestination(input);
  const reasonCodes: string[] = [];
  if (hasSecret) reasonCodes.push("credential_or_private_key");
  if (urlInspection.queryTooLarge) reasonCodes.push("oversized_url_query");
  if (hasPersonalData && !trustedDestination) reasonCodes.push("personal_data_to_untrusted_destination");

  const enforce = dataGuardrailMode() === "enforce";
  const shouldBlock = enforce && reasonCodes.length > 0;
  const shouldMonitor =
    !shouldBlock && (reasonCodes.length > 0 || protectedPayload.types.length > 0);

  return {
    ok: !shouldBlock,
    action: shouldBlock ? "block" : shouldMonitor ? "monitor" : "allow",
    ...(shouldBlock
      ? {
          error: urlInspection.queryTooLarge
            ? "目标 URL 查询参数过长，数据护栏已阻止外发。请缩短参数后重试。"
            : reasonCodes.includes("personal_data_to_untrusted_destination")
              ? "工具参数包含个人敏感信息，且目标未被管理员标记为可信连接，数据护栏已阻止外发。"
            : "工具参数包含凭据或私钥，数据护栏已阻止外发。请移除敏感信息后重试。",
        }
      : {}),
    types: protectedPayload.types,
    reasonCodes,
    payloadBytes,
    payloadHash: sha256(payload),
  };
}

export async function guardToolEgress(
  input: ToolEgressInput
): Promise<ToolEgressDecision> {
  const decision = evaluateToolEgress(input);
  if (decision.action !== "allow") {
    await recordAuditBestEffort({
      action:
        decision.action === "block"
          ? "security.tool_egress.blocked"
          : "security.tool_egress.detected",
      result: decision.action === "block" ? "denied" : "warning",
      severity: decision.action === "block" ? "high" : "medium",
      actorType: "agent",
      targetType: "external_tool",
      targetId: input.toolName || input.channel,
      targetName: input.toolName || input.channel,
      agentInstanceId: input.adoptId || null,
      source: "tool_egress_policy",
      channel: input.channel,
      toolName: input.toolName || null,
      policyCode:
        decision.action === "block"
          ? decision.reasonCodes.includes("oversized_url_query")
            ? "TOOL_EGRESS_URL_QUERY_BLOCK"
            : decision.reasonCodes.includes("personal_data_to_untrusted_destination")
              ? "TOOL_EGRESS_UNTRUSTED_PII_BLOCK"
            : "TOOL_EGRESS_SECRET_BLOCK"
          : "TOOL_EGRESS_SENSITIVE_MONITOR",
      riskType: [...decision.types, ...decision.reasonCodes].join(","),
      metadata: {
        channel: input.channel,
        destinationHost: destinationHost(input.destinationUrl),
        destinationTrust: input.destinationTrust || "unknown",
        payloadBytes: decision.payloadBytes,
        payloadHash: decision.payloadHash,
        sensitiveTypes: decision.types,
        reasonCodes: decision.reasonCodes,
      },
    });
  }
  return decision;
}
