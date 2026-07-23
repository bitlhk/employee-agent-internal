import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type AuthType = "none" | "bearer" | "api_key" | "query_api_key";

export type CustomMcpTemplate = {
  id: string;
  catalogId?: string;
  displayName: string;
  endpointUrl: string;
  authType: AuthType;
  authHeaderName?: string;
};

type CustomMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type CustomMcpConnection = {
  id: number;
  catalogId?: string | null;
  displayName: string;
  endpointUrl: string;
  authType: AuthType | "oauth";
  authHeaderName?: string | null;
  credentialConfigured: boolean;
  enabled: boolean;
  healthStatus: "unknown" | "ready" | "error";
  lastError?: string | null;
  tools: CustomMcpTool[];
  selectedToolNames?: string[] | null;
  lastTestedAt?: string | null;
};

type FormState = {
  id?: number;
  catalogId?: string;
  displayName: string;
  endpointUrl: string;
  authType: AuthType;
  authHeaderName: string;
  credential: string;
  credentialConfigured: boolean;
};

const EMPTY_FORM: FormState = {
  displayName: "",
  endpointUrl: "",
  authType: "none",
  authHeaderName: "X-API-Key",
  credential: "",
  credentialConfigured: false,
};

const QUERY_AUTH_PREFIX = "query:";

function storedAuthType(authType: AuthType): "none" | "bearer" | "api_key" {
  return authType === "query_api_key" ? "api_key" : authType;
}

function queryAuthParamName(value: unknown): string {
  const target = String(value || "").trim();
  return target.startsWith(QUERY_AUTH_PREFIX) ? target.slice(QUERY_AUTH_PREFIX.length) : "";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`);
  return data as T;
}

function endpointHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

export function CustomMcpDialog({
  open,
  initialMode,
  initialTemplate,
  adoptId,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  initialMode: "add" | "manage";
  initialTemplate?: CustomMcpTemplate | null;
  adoptId: string;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [view, setView] = useState<"manage" | "form">("manage");
  const [connections, setConnections] = useState<CustomMcpConnection[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [tools, setTools] = useState<CustomMcpTool[]>([]);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const maxConnections = 5;
  const maxTools = 20;

  const loadConnections = useCallback(async (silent = false) => {
    if (!adoptId) return;
    if (!silent) setLoading(true);
    try {
      const data = await requestJson<{ items: CustomMcpConnection[] }>(
        `/api/claw/custom-mcp/connections?adoptId=${encodeURIComponent(adoptId)}`,
      );
      setConnections(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "连接列表加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [adoptId]);

  const startAdd = useCallback((template?: CustomMcpTemplate | null) => {
    setForm(template ? {
      ...EMPTY_FORM,
      catalogId: template.catalogId || template.id,
      displayName: template.displayName,
      endpointUrl: template.endpointUrl,
      authType: template.authType,
      authHeaderName: template.authHeaderName || "X-API-Key",
    } : EMPTY_FORM);
    setTools([]);
    setSelectedTools(new Set());
    setPendingDeleteId(null);
    setView("form");
  }, []);

  useEffect(() => {
    if (!open) return;
    setPendingDeleteId(null);
    void loadConnections();
    if (initialMode === "add") startAdd(initialTemplate);
    else setView("manage");
  }, [initialMode, initialTemplate, loadConnections, open, startAdd]);

  const startEdit = (connection: CustomMcpConnection) => {
    if (connection.authType === "oauth") {
      toast.info("OAuth 连接请从连接器市场重新授权");
      return;
    }
    const queryParam = queryAuthParamName(connection.authHeaderName);
    setForm({
      id: connection.id,
      catalogId: connection.catalogId || undefined,
      displayName: connection.displayName,
      endpointUrl: connection.endpointUrl,
      authType: queryParam ? "query_api_key" : connection.authType,
      authHeaderName: queryParam || connection.authHeaderName || "X-API-Key",
      credential: "",
      credentialConfigured: connection.credentialConfigured,
    });
    setTools(connection.tools || []);
    setSelectedTools(new Set(connection.selectedToolNames || []));
    setPendingDeleteId(null);
    setView("form");
  };

  const invalidateTest = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setTools([]);
    setSelectedTools(new Set());
  };

  const connectionPayload = useMemo(() => ({
    adoptId,
    ...(form.id ? { connectionId: form.id } : {}),
    ...(form.catalogId ? { catalogId: form.catalogId } : {}),
    displayName: form.displayName.trim(),
    endpointUrl: form.endpointUrl.trim(),
    authType: storedAuthType(form.authType),
    authHeaderName: form.authType === "query_api_key"
      ? `${QUERY_AUTH_PREFIX}${form.authHeaderName.trim()}`
      : form.authType === "api_key" ? form.authHeaderName.trim() : undefined,
    ...(form.credential.trim() ? { credential: form.credential.trim() } : {}),
  }), [adoptId, form]);

  const testConnection = async () => {
    if (!form.endpointUrl.trim()) return toast.error("请填写 MCP 地址");
    setBusyAction("test");
    try {
      const data = await requestJson<{ tools: CustomMcpTool[] }>("/api/claw/custom-mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(connectionPayload),
      });
      const nextTools = Array.isArray(data.tools) ? data.tools : [];
      setTools(nextTools);
      const available = new Set(nextTools.map((tool) => tool.name));
      const retained = [...selectedTools].filter((name) => available.has(name)).slice(0, maxTools);
      setSelectedTools(new Set(retained.length > 0 ? retained : nextTools.slice(0, maxTools).map((tool) => tool.name)));
      toast.success(`连接成功，发现 ${nextTools.length} 个工具`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setBusyAction("");
    }
  };

  const saveConnection = async () => {
    if (!form.displayName.trim()) return toast.error("请填写连接名称");
    if (tools.length === 0) return toast.error("请先测试连接");
    if (selectedTools.size === 0) return toast.error("请至少启用一个工具");
    setBusyAction("save");
    try {
      await requestJson(form.id ? `/api/claw/custom-mcp/connections/${form.id}` : "/api/claw/custom-mcp/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...connectionPayload, selectedToolNames: [...selectedTools] }),
      });
      toast.success(form.id ? "连接已更新，下一轮对话生效" : "连接已添加，下一轮对话生效");
      await loadConnections(true);
      await onChanged?.();
      setView("manage");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "连接保存失败");
    } finally {
      setBusyAction("");
    }
  };

  const toggleTool = (name: string) => {
    setSelectedTools((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else if (next.size < maxTools) next.add(name);
      else toast.error(`每个连接最多启用 ${maxTools} 个工具`);
      return next;
    });
  };

  const mutateConnection = async (id: number, action: "toggle" | "retest" | "delete", enabled?: boolean) => {
    setBusyAction(`${action}:${id}`);
    try {
      if (action === "delete") {
        await requestJson(`/api/claw/custom-mcp/connections/${id}?adoptId=${encodeURIComponent(adoptId)}`, { method: "DELETE" });
        toast.success("连接已删除");
      } else if (action === "toggle") {
        await requestJson("/api/claw/mcp-tools/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adoptId, serverId: `custom_user_${id}`, enabled }),
        });
        toast.success(`连接已${enabled ? "启用" : "关闭"}`);
      } else {
        await requestJson(`/api/claw/custom-mcp/connections/${id}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adoptId }),
        });
        toast.success("连接测试通过");
      }
      setPendingDeleteId(null);
      await loadConnections(true);
      await onChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusyAction("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="custom-mcp-dialog" showCloseButton={!busyAction}>
        <DialogHeader className="custom-mcp-dialog__header">
          <DialogTitle>{view === "form" ? (form.id ? "编辑 MCP" : "添加 MCP") : "管理连接"}</DialogTitle>
          <DialogDescription>
            {view === "form" ? "连接 Streamable HTTP MCP，并选择当前岗位可用的工具。" : "当前岗位智能体的自定义业务连接。"}
          </DialogDescription>
        </DialogHeader>

        {view === "manage" ? (
          <div className="custom-mcp-manage">
            <div className="custom-mcp-manage__toolbar">
              <span>{connections.length}/{maxConnections} 个连接</span>
              <Button size="sm" onClick={() => startAdd()} disabled={connections.length >= maxConnections || Boolean(busyAction)}>
                <Plus />添加 MCP
              </Button>
            </div>
            <div className="custom-mcp-list">
              {loading ? (
                <div className="custom-mcp-empty"><LoaderCircle className="animate-spin" />正在加载</div>
              ) : connections.length === 0 ? (
                <div className="custom-mcp-empty"><Plug />还没有自定义连接</div>
              ) : connections.map((connection) => {
                const rowBusy = busyAction.endsWith(`:${connection.id}`);
                const selectedCount = connection.selectedToolNames?.length || 0;
                return (
                  <div key={connection.id} className="custom-mcp-row" data-enabled={connection.enabled ? "true" : "false"}>
                    <span className="custom-mcp-row__icon" data-status={connection.healthStatus}><Server /></span>
                    <span className="custom-mcp-row__main">
                      <span className="custom-mcp-row__name">{connection.displayName}</span>
                      <span className="custom-mcp-row__meta">
                        {endpointHost(connection.endpointUrl)} · {selectedCount} 个工具
                        {connection.authType === "oauth" ? " · OAuth" : ""}
                        {connection.healthStatus === "error" ? " · 连接异常" : connection.enabled ? " · 已连接" : " · 已关闭"}
                      </span>
                    </span>
                    {pendingDeleteId === connection.id ? (
                      <span className="custom-mcp-row__confirm">
                        <button type="button" onClick={() => setPendingDeleteId(null)}>取消</button>
                        <button type="button" data-danger="true" onClick={() => void mutateConnection(connection.id, "delete")}>删除</button>
                      </span>
                    ) : (
                      <span className="custom-mcp-row__actions">
                        <button type="button" title="重新测试" aria-label="重新测试" disabled={Boolean(busyAction)} onClick={() => void mutateConnection(connection.id, "retest")}>
                          {rowBusy && busyAction.startsWith("retest") ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                        </button>
                        {connection.authType !== "oauth" ? <button type="button" title="编辑" aria-label="编辑" disabled={Boolean(busyAction)} onClick={() => startEdit(connection)}><Pencil /></button> : null}
                        <button type="button" title="删除" aria-label="删除" disabled={Boolean(busyAction)} onClick={() => setPendingDeleteId(connection.id)}><Trash2 /></button>
                        <button
                          type="button"
                          className="custom-mcp-toggle"
                          data-checked={connection.enabled ? "true" : "false"}
                          aria-label={connection.enabled ? "关闭连接" : "启用连接"}
                          aria-pressed={connection.enabled}
                          disabled={Boolean(busyAction)}
                          onClick={() => void mutateConnection(connection.id, "toggle", !connection.enabled)}
                        >
                          {rowBusy && busyAction.startsWith("toggle") ? <LoaderCircle className="animate-spin" /> : <span />}
                        </button>
                      </span>
                    )}
                    {connection.lastError ? <span className="custom-mcp-row__error"><CircleAlert />{connection.lastError}</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="custom-mcp-form">
            <label>
              <span>连接名称</span>
              <Input value={form.displayName} maxLength={128} placeholder="例如：项目知识库" onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} />
            </label>
            <label>
              <span>Streamable HTTP 地址</span>
              <Input value={form.endpointUrl} placeholder="https://mcp.example.com/mcp" onChange={(event) => invalidateTest({ endpointUrl: event.target.value })} />
            </label>
            <div className="custom-mcp-form__auth">
              <label>
                <span>认证方式</span>
                <Select
                  value={form.authType}
                  onValueChange={(value: AuthType) => invalidateTest({
                    authType: value,
                    credential: "",
                    authHeaderName: value === "query_api_key" ? "token" : value === "api_key" ? "X-API-Key" : form.authHeaderName,
                  })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">无需认证</SelectItem>
                    <SelectItem value="bearer">Bearer Token</SelectItem>
                    <SelectItem value="api_key">API Key Header</SelectItem>
                    <SelectItem value="query_api_key">API Key Query</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {form.authType === "api_key" || form.authType === "query_api_key" ? (
                <label>
                  <span>{form.authType === "query_api_key" ? "Query 参数名" : "Header 名称"}</span>
                  <Input
                    value={form.authHeaderName}
                    placeholder={form.authType === "query_api_key" ? "token" : "X-API-Key"}
                    onChange={(event) => invalidateTest({ authHeaderName: event.target.value })}
                  />
                </label>
              ) : null}
            </div>
            {form.authType !== "none" ? (
              <label>
                <span>{form.authType === "bearer" ? "Token" : "API Key"}</span>
                <Input
                  type="password"
                  value={form.credential}
                  autoComplete="new-password"
                  placeholder={form.credentialConfigured ? "已保存，留空不修改" : "输入凭据"}
                  onChange={(event) => invalidateTest({ credential: event.target.value })}
                />
              </label>
            ) : null}

            <div className="custom-mcp-test-row">
              <Button type="button" variant="outline" size="sm" disabled={Boolean(busyAction)} onClick={() => void testConnection()}>
                {busyAction === "test" ? <LoaderCircle className="animate-spin" /> : <Plug />}测试连接
              </Button>
              {tools.length > 0 ? <span><Check />已发现 {tools.length} 个工具</span> : <span>仅支持公网 HTTPS 地址</span>}
            </div>

            {tools.length > 0 ? (
              <div className="custom-mcp-tools">
                <div className="custom-mcp-tools__header">
                  <span>启用工具</span>
                  <span>{selectedTools.size}/{Math.min(maxTools, tools.length)}</span>
                </div>
                <div className="custom-mcp-tools__list">
                  {tools.map((tool) => {
                    const checked = selectedTools.has(tool.name);
                    return (
                      <button key={tool.name} type="button" className="custom-mcp-tool" data-checked={checked ? "true" : "false"} onClick={() => toggleTool(tool.name)}>
                        <span className="custom-mcp-tool__check">{checked ? <Check /> : null}</span>
                        <span className="custom-mcp-tool__main">
                          <span>{tool.name}</span>
                          {tool.description ? <small>{tool.description}</small> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="custom-mcp-dialog__footer">
          {view === "form" ? (
            <>
              <Button type="button" variant="ghost" onClick={() => setView("manage")} disabled={Boolean(busyAction)}>返回</Button>
              <Button type="button" onClick={() => void saveConnection()} disabled={Boolean(busyAction) || tools.length === 0 || selectedTools.size === 0}>
                {busyAction === "save" ? <LoaderCircle className="animate-spin" /> : null}保存
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>完成</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
