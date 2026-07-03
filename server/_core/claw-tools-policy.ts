import express from "express";
import {
  requireClawOwner, readOpenclawJson,
} from "./helpers";
import { auditActor, auditRequest, recordAuditBestEffort } from "./audit-events";

export function registerToolsPolicyRoutes(app: express.Express) {

  // ── Tools policy / effective (agent self-awareness view) ──
  const TOOL_GROUPS = [
    { id: "fs", label: "Files", tools: [
      { id: "read", label: "read", description: "Read file contents", source: "core" },
      { id: "write", label: "write", description: "Create or overwrite files", source: "core" },
      { id: "edit", label: "edit", description: "Make precise edits", source: "core" },
    ]},
    { id: "runtime", label: "Runtime", tools: [
      { id: "exec", label: "exec", description: "Run shell commands", source: "core" },
      { id: "process", label: "process", description: "Manage background processes", source: "core" },
    ]},
    { id: "web", label: "Web", tools: [
      { id: "web_search", label: "web_search", description: "Search the web", source: "core" },
      { id: "web_fetch", label: "web_fetch", description: "Fetch web content", source: "core" },
      { id: "managed_browser_open", label: "managed_browser_open", description: "Open a public web page through the managed browser service", source: "employee_agent" },
      { id: "managed_browser_extract", label: "managed_browser_extract", description: "Extract public web page content as Markdown", source: "employee_agent" },
      { id: "managed_browser_snapshot", label: "managed_browser_snapshot", description: "Read a page structure snapshot", source: "employee_agent" },
      { id: "managed_browser_screenshot", label: "managed_browser_screenshot", description: "Capture a page screenshot when browser runtime is configured", source: "employee_agent" },
    ]},
    { id: "memory", label: "Memory", tools: [
      { id: "memory_search", label: "memory_search", description: "Semantic memory search", source: "core" },
      { id: "memory_get", label: "memory_get", description: "Read memory files", source: "core" },
    ]},
    { id: "sessions", label: "Sessions", tools: [
      { id: "sessions_list", label: "sessions_list", description: "List sessions", source: "core" },
      { id: "sessions_send", label: "sessions_send", description: "Send message to session", source: "core" },
      { id: "session_status", label: "session_status", description: "Get session status", source: "core" },
    ]},
  ] as const;

  const PROFILE_ALLOW: Record<string, string[]> = {
    starter_memory: ["read", "memory_search", "memory_get", "web_fetch", "managed_browser_open", "managed_browser_extract", "managed_browser_snapshot"],
    minimal: ["read", "web_fetch", "memory_search", "memory_get", "managed_browser_open", "managed_browser_extract", "managed_browser_snapshot"],
    coding: ["read", "write", "edit", "web_search", "web_fetch", "managed_browser_open", "managed_browser_extract", "managed_browser_snapshot", "managed_browser_screenshot", "memory_search", "memory_get", "sessions_list", "sessions_send", "session_status"],
    messaging: ["read", "web_fetch", "managed_browser_open", "managed_browser_extract", "managed_browser_snapshot", "memory_search", "memory_get", "sessions_list", "sessions_send", "session_status"],
    full: TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.id)),
  };

  const profileFromPermission = (permissionProfile: string) => {
    if (permissionProfile === "starter") return "starter_memory";
    if (permissionProfile === "plus") return "coding";
    if (permissionProfile === "internal") return "full";
    return "minimal";
  };

  app.get("/api/claw/tools/policy", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      // 从 OpenClaw 真实配置读取权限（单一来源）
      const ocJson = readOpenclawJson();
      const agentCfg = (ocJson?.agents?.list || []).find((a: any) => a.id === String((claw as any).agentId || "").trim());
      const tools = agentCfg?.tools || {};
      const defaults = ocJson?.agents?.defaults || {};
      const sandbox = defaults?.sandbox || {};

      await recordAuditBestEffort({
        action: "browser.policy.viewed",
        ...auditActor({ id: (claw as any).userId }),
        ...auditRequest(req),
        targetType: "agent",
        targetId: adoptId,
        targetName: String((claw as any).agentId || ""),
        agentInstanceId: adoptId,
        runtimeType: String(adoptId).startsWith("lgh-") ? "legacy_archived" : "openclaw",
        runtimeAgentId: String((claw as any).agentId || ""),
        policyCode: String(tools.profile || "none"),
        metadata: {
          route: "tools.policy",
          source: "openclaw_config",
          allowCount: Array.isArray(tools.allow) ? tools.allow.length : 0,
          denyCount: Array.isArray(tools.deny) ? tools.deny.length : 0,
          sandboxMode: sandbox.mode || "none",
        },
      });

      return res.json({
        adoptId,
        source: "openclaw_config",
        profile: tools.profile || "(none)",
        allow: tools.allow || [],
        deny: tools.deny || [],
        fs: tools.fs || {},
        exec: tools.exec || {},
        sandbox: {
          mode: sandbox.mode || "none",
          scope: sandbox.scope || "agent",
          docker: sandbox.docker || {},
        },
        model: agentCfg?.model || defaults?.model?.primary || "(inherited)",
      });
    } catch (e) {
      return res.status(500).json({ error: "tools policy failed" });
    }
  });

  app.get("/api/claw/tools/effective", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      // 从 OpenClaw 真实配置读取权限
      const ocJson = readOpenclawJson();
      const agentCfg = (ocJson?.agents?.list || []).find((a: any) => a.id === String((claw as any).agentId || "").trim());
      const tools = agentCfg?.tools || {};
      const defaults = ocJson?.agents?.defaults || {};
      const sandbox = defaults?.sandbox || {};

      const denySet = new Set<string>(tools.deny || []);
      const allowList: string[] = tools.allow || [];
      const profile = tools.profile || "(none)";

      // 构建工具组：结合 allow/deny 判断真实可用性
      const groups = TOOL_GROUPS.map((g) => ({
        id: g.id,
        label: g.label,
        tools: g.tools.map((t) => {
          // deny 优先；有 allow 列表时只放行在 allow 里的
          let runtimeAvailable: boolean;
          if (denySet.has(t.id)) {
            runtimeAvailable = false;
          } else if (allowList.length > 0) {
            runtimeAvailable = allowList.includes(t.id);
          } else {
            // coding/full profile 无 allow 列表 = 白名单为空 = 按 deny 倒推
            runtimeAvailable = true;
          }
          return {
            id: t.id,
            label: t.label,
            description: t.description,
            source: t.source,
            configuredAllowed: runtimeAvailable,
            runtimeAvailable,
            unavailableReason: runtimeAvailable ? undefined : "denied_by_policy",
            badge: "Built-in",
          };
        }),
      }));

      // exec 特殊处理：OpenClaw sandbox 开了就显示沙箱exec
      const execGroup = {
        id: "sandbox",
        label: "Sandbox",
        tools: [{
          id: "sandbox_exec",
          label: "sandbox_exec",
          description: `Docker 隔离执行 (image: ${sandbox.docker?.image || "openclaw-sandbox"}, network: ${sandbox.docker?.network || "none"}, readOnlyRoot: ${sandbox.docker?.readOnlyRoot ?? true})`,
          source: "openclaw_sandbox",
          configuredAllowed: sandbox.mode === "all" || sandbox.mode === "on",
          runtimeAvailable: sandbox.mode === "all" || sandbox.mode === "on",
          unavailableReason: sandbox.mode === "all" || sandbox.mode === "on" ? undefined : "sandbox_disabled",
          badge: "OpenClaw",
        }],
      };

      await recordAuditBestEffort({
        action: "browser.policy.effective_viewed",
        ...auditActor({ id: (claw as any).userId }),
        ...auditRequest(req),
        targetType: "agent",
        targetId: adoptId,
        targetName: String((claw as any).agentId || ""),
        agentInstanceId: adoptId,
        runtimeType: String(adoptId).startsWith("lgh-") ? "legacy_archived" : "openclaw",
        runtimeAgentId: String((claw as any).agentId || ""),
        policyCode: profile,
        metadata: {
          route: "tools.effective",
          source: "openclaw_config",
          groupCount: groups.length + 1,
          sandboxAvailable: execGroup.tools[0].runtimeAvailable,
        },
      });

      return res.json({
        adoptId,
        profile,
        source: "openclaw_config",
        groups: [...groups, execGroup],
      });
    } catch (e) {
      return res.status(500).json({ error: "tools effective failed" });
    }
  });

}
