import type { ToolSideEffect } from "../tool-governance";
import { governanceFingerprint } from "./contracts";
import { setGovernancePepCoverage } from "../observability/metrics";

export type CapabilityPep = {
  id: string;
  kind: "route" | "gateway" | "runtime_hook" | "sandbox" | "database" | "policy_adapter";
  deterministic: boolean;
  failClose: boolean;
};

export type CapabilityExecutionProof = {
  id: string;
  kind: "route_integration" | "runtime_invariant" | "boundary_test";
  testFile: string;
};

export type CapabilityRegistration = {
  id: string;
  entry: string;
  router: string;
  executor: string;
  sideEffect: ToolSideEffect;
  active: boolean;
  pep: CapabilityPep | null;
  executionProof: CapabilityExecutionProof | null;
  audit: "none" | "best_effort" | "required";
};

export const CAPABILITY_REGISTRY: readonly CapabilityRegistration[] = [
  { id: "jiuwen.runtime.read", entry: "JiuwenSwarm tool", router: "UserHookRail", executor: "Jiuwen runtime", sideEffect: "read", active: true, pep: { id: "jiuwen-pre-tool", kind: "runtime_hook", deterministic: true, failClose: true }, executionProof: null, audit: "best_effort" },
  { id: "jiuwen.runtime.compute", entry: "JiuwenSwarm Bash/code", router: "UserHookRail", executor: "Docker sandbox", sideEffect: "compute", active: true, pep: { id: "sandbox-boundary", kind: "sandbox", deterministic: true, failClose: true }, executionProof: { id: "jiuwen-compute-boundary", kind: "boundary_test", testFile: "server/_core/sandbox.test.ts" }, audit: "best_effort" },
  { id: "jiuwen.runtime.workspace", entry: "JiuwenSwarm file tools", router: "UserHookRail", executor: "Workspace file API", sideEffect: "workspace_write", active: true, pep: { id: "workspace-boundary", kind: "route", deterministic: true, failClose: true }, executionProof: { id: "jiuwen-workspace-hook", kind: "runtime_invariant", testFile: "server/_core/tool-egress-routes.test.ts" }, audit: "best_effort" },
  { id: "jiuwen.runtime.business", entry: "JiuwenSwarm tool", router: "UserHookRail", executor: "Registered capability", sideEffect: "write", active: true, pep: { id: "jiuwen-pre-tool", kind: "runtime_hook", deterministic: true, failClose: true }, executionProof: { id: "jiuwen-business-hook", kind: "runtime_invariant", testFile: "server/_core/governance-invariants.test.ts" }, audit: "best_effort" },
  { id: "platform.mcp", entry: "/api/internal/platform-tools/mcp", router: "platform-tools-mcp", executor: "Platform function", sideEffect: "write", active: true, pep: { id: "platform-mcp-policy", kind: "gateway", deterministic: true, failClose: true }, executionProof: { id: "platform-mcp-authority-deny-no-execute", kind: "route_integration", testFile: "server/_core/platform-tools-mcp.wiring.test.ts" }, audit: "best_effort" },
  { id: "custom.mcp", entry: "/api/internal/custom-mcp/mcp", router: "custom-mcp", executor: "Remote MCP", sideEffect: "write", active: true, pep: { id: "custom-mcp-governance", kind: "gateway", deterministic: true, failClose: true }, executionProof: { id: "custom-mcp-deny-no-execute", kind: "route_integration", testFile: "server/_core/custom-mcp-gateway.test.ts" }, audit: "best_effort" },
  { id: "enterprise.mcp", entry: "/api/internal/enterprise-mcp/mcp", router: "enterprise-mcp-gateway", executor: "Remote MCP", sideEffect: "write", active: true, pep: { id: "enterprise-mcp-policy", kind: "gateway", deterministic: true, failClose: true }, executionProof: { id: "enterprise-mcp-deny-no-execute", kind: "route_integration", testFile: "server/_core/enterprise-mcp-gateway.test.ts" }, audit: "required" },
  { id: "role.mcp.read", entry: "/api/internal/role-mcp/mcp", router: "role-mcp-gateway", executor: "Platform-configured MCP", sideEffect: "read", active: true, pep: { id: "role-scope-and-read-only-gate", kind: "gateway", deterministic: true, failClose: true }, executionProof: { id: "role-mcp-write-tools-not-exposed", kind: "boundary_test", testFile: "server/_core/role-mcp-gateway.test.ts" }, audit: "best_effort" },
  { id: "a2a.task", entry: "/api/claw/agent-tasks/submit", router: "claw-agent-tasks", executor: "A2A client", sideEffect: "external_send", active: true, pep: { id: "a2a-task-policy", kind: "route", deterministic: true, failClose: true }, executionProof: { id: "a2a-submit-and-worker-authority-deny-no-execute", kind: "route_integration", testFile: "server/_core/claw-agent-tasks.routes.test.ts" }, audit: "best_effort" },
  { id: "a2a.intent.execute", entry: "/api/claw/agent-tasks/:taskId/capability-intents/:intentId/execute", router: "a2a-capability-intent-routes", executor: "Enterprise MCP gateway", sideEffect: "write", active: true, pep: { id: "a2a-local-intent-binding-and-enterprise-mcp-policy", kind: "route", deterministic: true, failClose: true }, executionProof: { id: "a2a-intent-unsupported-and-approval-no-execute", kind: "route_integration", testFile: "server/_core/a2a-capability-intent-routes.test.ts" }, audit: "required" },
  { id: "collaboration.execute", entry: "/api/claw/collab", router: "claw-collab", executor: "Retired runtime executor", sideEffect: "external_send", active: false, pep: null, executionProof: null, audit: "best_effort" },
  { id: "sandbox.exec", entry: "/api/claw/sandbox/exec", router: "claw-sandbox", executor: "Docker", sideEffect: "compute", active: true, pep: { id: "sandbox-policy", kind: "sandbox", deterministic: true, failClose: true }, executionProof: { id: "sandbox-boundary", kind: "boundary_test", testFile: "server/_core/sandbox.test.ts" }, audit: "best_effort" },
  { id: "browser.fetch", entry: "/api/internal/browser", router: "managed-browser", executor: "Pinned HTTP client", sideEffect: "read", active: true, pep: { id: "browser-egress-policy", kind: "route", deterministic: true, failClose: true }, executionProof: null, audit: "best_effort" },
  { id: "notification.send", entry: "/api/claw/notify/test", router: "claw-notify", executor: "Notification provider", sideEffect: "external_send", active: true, pep: { id: "notification-authority-egress", kind: "route", deterministic: true, failClose: true }, executionProof: { id: "notification-authority-deny-no-execute", kind: "route_integration", testFile: "server/_core/claw-notify.wiring.test.ts" }, audit: "best_effort" },
  { id: "feishu.send", entry: "/api/claw/feishu/test", router: "claw-feishu", executor: "Feishu API", sideEffect: "external_send", active: true, pep: { id: "feishu-authority-egress", kind: "route", deterministic: true, failClose: true }, executionProof: { id: "feishu-authority-deny-no-execute", kind: "route_integration", testFile: "server/_core/claw-feishu.wiring.test.ts" }, audit: "best_effort" },
  { id: "cron.write", entry: "/api/claw/cron/add|update|run|remove", router: "claw-cron", executor: "Cron provider", sideEffect: "write", active: true, pep: { id: "cron-authority-idempotency", kind: "route", deterministic: true, failClose: true }, executionProof: { id: "cron-authority-deny-no-execute", kind: "route_integration", testFile: "server/_core/claw-cron.wiring.test.ts" }, audit: "best_effort" },
  { id: "cron.delivery", entry: "/api/internal/jiuwen/callback", router: "jiuwen-webhook", executor: "Channel provider", sideEffect: "external_send", active: true, pep: { id: "cron-delivery-authority-egress", kind: "route", deterministic: true, failClose: true }, executionProof: { id: "cron-delivery-authority-deny-no-execute", kind: "route_integration", testFile: "server/_core/jiuwen-webhook.wiring.test.ts" }, audit: "best_effort" },
  { id: "workspace.files", entry: "/api/claw/files/upload|delete", router: "claw-files", executor: "Workspace filesystem", sideEffect: "workspace_write", active: true, pep: { id: "workspace-authority-boundary", kind: "route", deterministic: true, failClose: true }, executionProof: { id: "workspace-authority-deny-no-execute", kind: "route_integration", testFile: "server/_core/claw-files.wiring.test.ts" }, audit: "best_effort" },
  { id: "intent.side_effect", entry: "disabled EA project-manager intent executor", router: "intent-executor", executor: "Skill store / channel provider", sideEffect: "write", active: false, pep: { id: "intent-execution-authority", kind: "policy_adapter", deterministic: true, failClose: true }, executionProof: null, audit: "best_effort" },
  { id: "knowledge.retrieve", entry: "chat knowledge context", router: "knowledge-context", executor: "Knowledge retrieval", sideEffect: "read", active: true, pep: { id: "knowledge-eligibility", kind: "policy_adapter", deterministic: true, failClose: true }, executionProof: null, audit: "best_effort" },
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

export function unprovenActiveSideEffects(
  capabilities: readonly CapabilityRegistration[] = CAPABILITY_REGISTRY,
): CapabilityRegistration[] {
  return capabilities.filter(item => item.active && item.sideEffect !== "read" && !item.executionProof);
}

export function publishCapabilityPepCoverage(): {
  total: number;
  declared: number;
  executionProven: number;
} {
  const relevant = CAPABILITY_REGISTRY.filter(item => item.active && item.sideEffect !== "read");
  const uncovered = uncoveredActiveSideEffects(relevant);
  const unproven = unprovenActiveSideEffects(relevant);
  const snapshot = {
    total: relevant.length,
    declared: relevant.length - uncovered.length,
    executionProven: relevant.length - unproven.length,
  };
  setGovernancePepCoverage(snapshot);
  return snapshot;
}
