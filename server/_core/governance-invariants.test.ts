import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recordAuditBestEffort: vi.fn().mockResolvedValue(null) }));
vi.mock("./audit-events", () => ({ recordAuditBestEffort: mocks.recordAuditBestEffort }));

import { evaluateJiuwenPreToolUse } from "./tool-egress-routes";
import {
  POLICY_GATED_SIDE_EFFECTS,
  TOOL_GOVERNANCE_REGISTRY,
  resolveToolGovernance,
} from "./tool-governance";
import {
  CAPABILITY_REGISTRY,
  capabilitySetFingerprint,
  unprovenActiveSideEffects,
  uncoveredActiveSideEffects,
} from "./governance/capability-registry";

const RUNTIME_TOOLS = [
  "ask_user", "bash", "code", "edit_file", "edit_memory", "evolve_review_task",
  "evolve_skill_experiences", "glob", "grep", "list_files", "list_skill",
  "list_skill_experiences", "load_tools", "memory_get", "memory_search",
  "prepare_skill_evolution", "read_file", "read_memory", "read_skill_experiences",
  "search_tools", "simplify_skill_experiences", "skill_tool", "task_tool",
  "todo_create", "todo_get", "todo_list", "todo_modify", "write_file", "write_memory",
] as const;

const CHAT_ENTRYPOINTS = new Map([
  ["/api/claw/chat-stream", "direct"],
  ["/api/desktop/jiuwen/v1/chat/completions", "proxy"],
  ["/api/internal/miniprogram/experience/chat", "proxy"],
] as const);

function serverTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return serverTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("governance invariants", () => {
  it("keeps every active side-effect capability behind a deterministic fail-close PEP", () => {
    expect(uncoveredActiveSideEffects()).toEqual([]);
    expect(unprovenActiveSideEffects()).toEqual([]);
    expect(new Set(CAPABILITY_REGISTRY.map(item => item.id)).size).toBe(CAPABILITY_REGISTRY.length);
    const proofIds = CAPABILITY_REGISTRY.flatMap(item => item.executionProof?.id ? [item.executionProof.id] : []);
    expect(new Set(proofIds).size).toBe(proofIds.length);
    for (const capability of CAPABILITY_REGISTRY.filter(item => item.active && item.sideEffect !== "read")) {
      expect(capability.executionProof?.testFile, capability.id).toMatch(/\.test\.ts$/);
      expect(readFileSync(join(fileURLToPath(new URL("../../", import.meta.url)), capability.executionProof!.testFile), "utf8").length).toBeGreaterThan(0);
    }
    expect(capabilitySetFingerprint()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires real route integration proof for every active HTTP side-effect PEP", () => {
    const httpCapabilities = CAPABILITY_REGISTRY.filter(item => (
      item.active
      && item.sideEffect !== "read"
      && item.entry.startsWith("/api/")
      && item.pep?.kind !== "sandbox"
    ));
    expect(httpCapabilities.length).toBeGreaterThan(0);
    for (const capability of httpCapabilities) {
      expect(capability.executionProof?.kind, capability.id).toBe("route_integration");
    }
  });

  it("keeps every known runtime tool in the governance registry", () => {
    for (const tool of RUNTIME_TOOLS) expect(resolveToolGovernance(tool).registered, tool).toBe(true);
  });

  it("requires policy evaluation for every policy-governed registry entry", () => {
    for (const rule of TOOL_GOVERNANCE_REGISTRY) {
      if (POLICY_GATED_SIDE_EFFECTS.has(rule.sideEffect)) expect(rule.policyRequired).toBe(true);
    }
  });

  it("distinguishes workspace writes, business writes, code, and external agents", () => {
    expect(resolveToolGovernance("write_file")).toMatchObject({ sideEffect: "workspace_write", policyRequired: false });
    expect(resolveToolGovernance("create_portfolio")).toMatchObject({ sideEffect: "write", policyRequired: true });
    expect(resolveToolGovernance("bash")).toMatchObject({ sideEffect: "compute", policyRequired: true, registered: true });
    expect(resolveToolGovernance("a2a_expert_call")).toMatchObject({ sideEffect: "external_send", policyRequired: true });
    expect(resolveToolGovernance("mcp_platform_tools_get_user_channels")).toMatchObject({ sideEffect: "read" });
    expect(resolveToolGovernance("mcp_platform_tools_get_wealth_policy_basis")).toMatchObject({
      sideEffect: "read",
      policyRequired: false,
      registered: true,
    });
    expect(resolveToolGovernance("mcp_platform_tools_prepare_wealth_maturity_context")).toMatchObject({
      sideEffect: "read",
      policyRequired: false,
      registered: true,
    });
    expect(resolveToolGovernance("mcp_platform_tools_prepare_wealth_allocation_context")).toMatchObject({
      sideEffect: "read",
      policyRequired: false,
      registered: true,
    });
    expect(resolveToolGovernance("mcp_platform_tools_prepare_wealth_previsit_context")).toMatchObject({
      sideEffect: "read",
      policyRequired: false,
      registered: true,
    });
    expect(resolveToolGovernance("mcp_platform_tools_evaluate_post_loan_risk_escalation")).toMatchObject({
      sideEffect: "compute",
      policyRequired: false,
      registered: true,
    });
    expect(resolveToolGovernance("mcp_platform_tools_create_scheduled_task")).toMatchObject({ sideEffect: "write", idempotencyRequired: true });
    expect(resolveToolGovernance("mcp_platform_tools_submit_agent_task")).toMatchObject({ sideEffect: "external_send", idempotencyRequired: true });
    expect(resolveToolGovernance("audio_question_answering")).toMatchObject({ sideEffect: "compute", registered: true });
    expect(resolveToolGovernance("visual_question_answering")).toMatchObject({ sideEffect: "compute", registered: true });
    expect(resolveToolGovernance("wiki_query")).toMatchObject({ sideEffect: "read", registered: true });
    expect(resolveToolGovernance("cron_create_job")).toMatchObject({ sideEffect: "write", registered: false });
    expect(resolveToolGovernance("mcp_custom_mcp_gateway_custom_1_update_customer")).toMatchObject({
      sideEffect: "write", registered: true, policyRequired: true,
    });
    expect(resolveToolGovernance("mcp_enterprise_mcp_gateway_enterprise_ab12_update_customer")).toMatchObject({
      sideEffect: "write", registered: true, policyRequired: true,
    });
    expect(resolveToolGovernance("mcp_role_mcp_gateway_role_ab12_bond_parse_schema")).toMatchObject({
      sideEffect: "read",
      policyRequired: false,
      auditLevel: "strong",
    });
  });

  it("fails closed for a newly introduced side-effect tool", async () => {
    await expect(evaluateJiuwenPreToolUse({
      tool_name: "update_unregistered_business_record",
      tool_input: { id: 1 },
    })).resolves.toMatchObject({ decision: "block", policyCode: "EA_TOOL_GOVERNANCE_UNREGISTERED" });
  });

  it("audits both ALLOW and DENY decisions with a policy decision id", async () => {
    mocks.recordAuditBestEffort.mockClear();
    await evaluateJiuwenPreToolUse({ tool_name: "read_file", tool_input: { path: "a.md" } });
    await evaluateJiuwenPreToolUse({ tool_name: "delete_customer", tool_input: { id: 1 } });
    expect(mocks.recordAuditBestEffort).toHaveBeenCalledTimes(2);
    expect(mocks.recordAuditBestEffort.mock.calls.map(([event]) => event.result)).toEqual(["success", "denied"]);
    for (const [event] of mocks.recordAuditBestEffort.mock.calls) {
      expect(event.metadata.policyDecisionId).toMatch(/^pdec_/);
    }
  });

  it("keeps the chat entrypoint inventory complete and behind instruction-attack inspection", () => {
    const serverRoot = fileURLToPath(new URL("../", import.meta.url));
    const actual = new Map<string, string>();
    for (const path of serverTypeScriptFiles(serverRoot)) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/app\.post\(\s*["']([^"']+)["']/g)) {
        const route = match[1];
        if (route.endsWith("/chat") || route.endsWith("/chat-stream") || route.endsWith("/chat/completions")) {
          actual.set(route, path);
        }
      }
    }
    expect(Array.from(actual.keys()).sort()).toEqual(Array.from(CHAT_ENTRYPOINTS.keys()).sort());
    for (const [route, mode] of CHAT_ENTRYPOINTS) {
      const source = readFileSync(actual.get(route)!, "utf8");
      if (mode === "direct") expect(source).toContain("detectInstructionAttackSignals(userMessage)");
      else expect(source).toContain("/api/claw/chat-stream");
    }
  });
});
