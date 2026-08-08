import type { ToolSideEffect } from "../tool-governance";
import { governanceFingerprint } from "./contracts";
import { setGovernancePepCoverage } from "../observability/metrics";

export type CapabilityPep = {
  id: string;
  kind: "route" | "gateway" | "runtime_hook" | "sandbox" | "database" | "policy_adapter";
  deterministic: boolean;
  failClose: boolean;
};

export type CapabilityRegistration = {
  id: string;
  entry: string;
  router: string;
  executor: string;
  sideEffect: ToolSideEffect;
  active: boolean;
  pep: CapabilityPep | null;
  audit: "none" | "best_effort" | "required";
};

export const CAPABILITY_REGISTRY: readonly CapabilityRegistration[] = [
  { id: "jiuwen.runtime.read", entry: "JiuwenSwarm tool", router: "UserHookRail", executor: "Jiuwen runtime", sideEffect: "read", active: true, pep: { id: "jiuwen-pre-tool", kind: "runtime_hook", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "jiuwen.runtime.compute", entry: "JiuwenSwarm Bash/code", router: "UserHookRail", executor: "Docker sandbox", sideEffect: "compute", active: true, pep: { id: "sandbox-boundary", kind: "sandbox", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "jiuwen.runtime.workspace", entry: "JiuwenSwarm file tools", router: "UserHookRail", executor: "Workspace file API", sideEffect: "workspace_write", active: true, pep: { id: "workspace-boundary", kind: "route", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "jiuwen.runtime.business", entry: "JiuwenSwarm tool", router: "UserHookRail", executor: "Registered capability", sideEffect: "write", active: true, pep: { id: "jiuwen-pre-tool", kind: "runtime_hook", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "platform.mcp", entry: "/api/internal/platform-tools/mcp", router: "platform-tools-mcp", executor: "Platform function", sideEffect: "write", active: true, pep: { id: "platform-mcp-policy", kind: "gateway", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "custom.mcp", entry: "/api/internal/custom-mcp/mcp", router: "custom-mcp", executor: "Remote MCP", sideEffect: "write", active: true, pep: { id: "custom-mcp-governance", kind: "gateway", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "enterprise.mcp", entry: "/api/internal/enterprise-mcp/mcp", router: "enterprise-mcp-gateway", executor: "Remote MCP", sideEffect: "write", active: true, pep: { id: "enterprise-mcp-policy", kind: "gateway", deterministic: true, failClose: true }, audit: "required" },
  { id: "a2a.task", entry: "/api/claw/agents/tasks", router: "claw-agent-tasks", executor: "A2A client", sideEffect: "external_send", active: true, pep: { id: "a2a-task-policy", kind: "route", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "collaboration.execute", entry: "/api/claw/collab", router: "claw-collab", executor: "Retired runtime executor", sideEffect: "external_send", active: false, pep: null, audit: "best_effort" },
  { id: "sandbox.exec", entry: "/api/claw/sandbox/exec", router: "claw-sandbox", executor: "Docker", sideEffect: "compute", active: true, pep: { id: "sandbox-policy", kind: "sandbox", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "browser.fetch", entry: "/api/internal/browser", router: "managed-browser", executor: "Pinned HTTP client", sideEffect: "read", active: true, pep: { id: "browser-egress-policy", kind: "route", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "notification.send", entry: "/api/claw/notify", router: "claw-notify", executor: "Notification provider", sideEffect: "external_send", active: true, pep: { id: "external-delivery-guard", kind: "route", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "feishu.send", entry: "/api/claw/feishu", router: "claw-feishu", executor: "Feishu API", sideEffect: "external_send", active: true, pep: { id: "external-delivery-guard", kind: "route", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "cron.write", entry: "/api/claw/cron", router: "claw-cron", executor: "Cron provider", sideEffect: "write", active: true, pep: { id: "cron-owner-idempotency", kind: "database", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "workspace.files", entry: "/api/claw/files", router: "claw-files", executor: "Workspace filesystem", sideEffect: "workspace_write", active: true, pep: { id: "workspace-boundary", kind: "route", deterministic: true, failClose: true }, audit: "best_effort" },
  { id: "knowledge.retrieve", entry: "chat knowledge context", router: "knowledge-context", executor: "Knowledge retrieval", sideEffect: "read", active: true, pep: { id: "knowledge-eligibility", kind: "policy_adapter", deterministic: true, failClose: true }, audit: "best_effort" },
] as const;

export function capabilitySetFingerprint(
  capabilities: readonly CapabilityRegistration[] = CAPABILITY_REGISTRY,
): string {
  return governanceFingerprint(capabilities.filter(item => item.active).map(item => ({
    id: item.id,
    sideEffect: item.sideEffect,
    pep: item.pep?.id || null,
  })));
}

export function uncoveredActiveSideEffects(
  capabilities: readonly CapabilityRegistration[] = CAPABILITY_REGISTRY,
): CapabilityRegistration[] {
  return capabilities.filter(item => (
    item.active
    && item.sideEffect !== "read"
    && (!item.pep?.deterministic || !item.pep.failClose)
  ));
}

export function publishCapabilityPepCoverage(): { total: number; covered: number } {
  const relevant = CAPABILITY_REGISTRY.filter(item => item.active && item.sideEffect !== "read");
  const uncovered = uncoveredActiveSideEffects(relevant);
  const snapshot = { total: relevant.length, covered: relevant.length - uncovered.length };
  setGovernancePepCoverage(snapshot);
  return snapshot;
}
