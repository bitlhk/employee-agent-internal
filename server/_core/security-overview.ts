export type SecurityOverviewStatus = "normal" | "attention" | "risk" | "unverified";
export type SecurityCapabilityStatus = "covered" | "partial" | "risk" | "unverified";

export interface SecurityOverviewStatusInput {
  ledgerAvailable: boolean;
  ledgerHealthy: boolean;
  hasLedgerEvents: boolean;
  failedEvents24h: number;
  deniedEvents24h: number;
  highRiskEvents24h: number;
  activeFindings: number;
  highRiskFindings: number;
  dlqEvents: number;
  nativeExecutions7d: number;
  traceabilityPercents: Array<number | null>;
}

export function ratioPercent(bound: number, expected: number): number | null {
  if (!Number.isFinite(expected) || expected <= 0) return null;
  const ratio = Math.max(0, Math.min(1, Number(bound || 0) / expected));
  return Math.round(ratio * 1000) / 10;
}

export function traceabilityCoverage(bound: number, expected: number): SecurityCapabilityStatus {
  const percent = ratioPercent(bound, expected);
  if (percent === null) return "unverified";
  return percent >= 95 ? "covered" : "partial";
}

export function deriveSecurityOverviewStatus(input: SecurityOverviewStatusInput): {
  status: SecurityOverviewStatus;
  reasons: string[];
} {
  if (!input.ledgerAvailable || !input.hasLedgerEvents) {
    return {
      status: "unverified",
      reasons: [input.ledgerAvailable ? "审计账本暂无事件，无法判断近期状态" : "审计账本不可用，无法完成安全检查"],
    };
  }

  const riskReasons: string[] = [];
  if (input.highRiskEvents24h > 0) riskReasons.push(`近24小时有 ${input.highRiskEvents24h} 个高危事件`);
  if (input.highRiskFindings > 0) riskReasons.push(`存在 ${input.highRiskFindings} 个未关闭的高危发现`);
  if (input.nativeExecutions7d > 0) riskReasons.push(`近7天记录到 ${input.nativeExecutions7d} 次宿主机工具执行`);
  if (riskReasons.length > 0) return { status: "risk", reasons: riskReasons };

  const attentionReasons: string[] = [];
  if (!input.ledgerHealthy) attentionReasons.push("审计账本完整性基线需要检查");
  if (input.dlqEvents > 0) attentionReasons.push(`审计失败队列中有 ${input.dlqEvents} 个事件`);
  if (input.failedEvents24h > 0) attentionReasons.push(`近24小时有 ${input.failedEvents24h} 个失败事件`);
  if (input.deniedEvents24h > 0) attentionReasons.push(`近24小时策略阻断 ${input.deniedEvents24h} 次`);
  if (input.activeFindings > 0) attentionReasons.push(`有 ${input.activeFindings} 个风险发现待处理`);
  if (input.traceabilityPercents.some((percent) => percent !== null && percent < 95)) {
    attentionReasons.push("部分审计事件的身份或运行时绑定不完整");
  }
  if (attentionReasons.length > 0) return { status: "attention", reasons: attentionReasons };

  return { status: "normal", reasons: ["审计链路正常，近24小时未发现高危或失败事件"] };
}
