import { recordAuditBestEffort } from "./audit-events";
import {
  dataGuardrailMode,
  protectExternalText,
  type DataGuardrailAction,
  type SensitiveDataType,
} from "./data-guardrail";

type ExternalDeliveryInput = {
  adoptId?: string;
  channel: string;
  text: string;
  title?: string;
};

export type ExternalDeliveryGuardResult =
  | {
      ok: true;
      text: string;
      title?: string;
      action: Exclude<DataGuardrailAction, "block">;
      types: SensitiveDataType[];
    }
  | {
      ok: false;
      error: string;
      action: "block";
      types: SensitiveDataType[];
    };

function strongestAction(actions: DataGuardrailAction[]): DataGuardrailAction {
  if (actions.includes("block")) return "block";
  if (actions.includes("redact")) return "redact";
  return "allow";
}

export async function guardExternalDelivery(
  input: ExternalDeliveryInput
): Promise<ExternalDeliveryGuardResult> {
  const mode = dataGuardrailMode();
  const textDecision = protectExternalText(input.text, {
    mode,
    requireBankCardContext: true,
  });
  const titleDecision = protectExternalText(input.title || "", {
    mode,
    requireBankCardContext: true,
  });
  const types = [...new Set([...textDecision.types, ...titleDecision.types])];
  const action = strongestAction([textDecision.action, titleDecision.action]);

  if (types.length) {
    const auditAction =
      action === "block"
        ? "data_guard.external_delivery.blocked"
        : action === "redact"
          ? "data_guard.external_delivery.redacted"
          : "data_guard.external_delivery.detected";
    await recordAuditBestEffort({
      action: auditAction,
      result: action === "block" ? "denied" : "warning",
      severity: action === "block" ? "high" : "medium",
      actorType: "agent",
      targetType: "external_channel",
      targetId: input.channel,
      agentInstanceId: input.adoptId || null,
      source: "data_guardrail",
      channel: input.channel,
      policyCode:
        action === "block"
          ? "SENSITIVE_SECRET_EXTERNAL_BLOCK"
          : "SENSITIVE_PII_EXTERNAL_REDACT",
      riskType: types.join(","),
      metadata: {
        mode,
        types,
        detectionCount:
          textDecision.detections.length + titleDecision.detections.length,
        textLength: Array.from(input.text).length,
        titleLength: Array.from(input.title || "").length,
      },
    });
  }

  if (action === "block") {
    return {
      ok: false,
      error: "消息包含凭据或私钥，数据护栏已阻止外发。请移除敏感信息后重试。",
      action,
      types,
    };
  }
  return {
    ok: true,
    text: textDecision.text,
    ...(input.title === undefined ? {} : { title: titleDecision.text }),
    action,
    types,
  };
}
