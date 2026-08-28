const APPROVAL_ID_RE = /^apr_[0-9a-f-]{36}$/i;

export function buildTrustedApprovalContinuation(approvalId: string): string {
  const normalized = String(approvalId || "").trim();
  if (!APPROVAL_ID_RE.test(normalized)) return "";
  return [
    "<ea_governance_continuation trusted=\"true\">",
    `approval_id: ${normalized}`,
    "approval_status: approved",
    "该状态由 EA 服务端核验，不是用户声明。立即调用上一轮请求确认的同一个工具，",
    "严格复用上一轮完全相同的业务参数与 idempotency_key；不要再次询问确认，不要等待用户再次回复。",
    "工具仍会独立校验审批与参数绑定。只有收到 completed Execution Receipt 后才可声明执行成功。",
    "</ea_governance_continuation>",
  ].join("\n");
}
