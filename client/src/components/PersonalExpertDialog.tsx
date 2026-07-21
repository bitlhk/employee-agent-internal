import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BrainCircuit,
  Check,
  CircleAlert,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
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
import { Textarea } from "@/components/ui/textarea";

type AuthType = "none" | "bearer";
type InteractionMode = "single" | "session";

type PersonalExpert = {
  id: string;
  name: string;
  description: string;
  endpointUrl: string;
  authType: AuthType;
  credentialConfigured: boolean;
  interactionMode: InteractionMode;
  enabled: boolean;
  healthStatus: "healthy" | "degraded" | "offline" | "unknown";
  lastError?: string | null;
  lastHealthCheck?: string | null;
};

type FormState = {
  id?: string;
  name: string;
  description: string;
  endpointUrl: string;
  authType: AuthType;
  credential: string;
  credentialConfigured: boolean;
  interactionMode: InteractionMode;
};

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  endpointUrl: "",
  authType: "none",
  credential: "",
  credentialConfigured: false,
  interactionMode: "single",
};

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

function expertStatus(expert: PersonalExpert): string {
  if (!expert.enabled) return "已关闭";
  if (expert.healthStatus === "healthy") return "已连接";
  if (expert.healthStatus === "offline") return "连接异常";
  return "待测试";
}

export function PersonalExpertDialog({
  open,
  initialMode,
  adoptId,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  initialMode: "add" | "manage";
  adoptId: string;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [view, setView] = useState<"manage" | "form">("manage");
  const [experts, setExperts] = useState<PersonalExpert[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [connectionDirty, setConnectionDirty] = useState(true);
  const [connectionTested, setConnectionTested] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const maxExperts = 3;

  const loadExperts = useCallback(async (silent = false) => {
    if (!adoptId) return;
    if (!silent) setLoading(true);
    try {
      const data = await requestJson<{ items: PersonalExpert[]; limits?: { experts?: number } }>(
        `/api/claw/personal-experts?adoptId=${encodeURIComponent(adoptId)}`,
      );
      setExperts(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "专家列表加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [adoptId]);

  const startAdd = useCallback(() => {
    setForm(EMPTY_FORM);
    setConnectionDirty(true);
    setConnectionTested(false);
    setPendingDeleteId(null);
    setView("form");
  }, []);

  useEffect(() => {
    if (!open) return;
    setPendingDeleteId(null);
    void loadExperts();
    if (initialMode === "add") startAdd();
    else setView("manage");
  }, [initialMode, loadExperts, open, startAdd]);

  const startEdit = (expert: PersonalExpert) => {
    setForm({
      id: expert.id,
      name: expert.name,
      description: expert.description || "",
      endpointUrl: expert.endpointUrl,
      authType: expert.authType,
      credential: "",
      credentialConfigured: expert.credentialConfigured,
      interactionMode: expert.interactionMode || "single",
    });
    setConnectionDirty(false);
    setConnectionTested(expert.healthStatus === "healthy");
    setPendingDeleteId(null);
    setView("form");
  };

  const updateConnection = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setConnectionDirty(true);
    setConnectionTested(false);
  };

  const connectionPayload = useMemo(() => ({
    adoptId,
    ...(form.id ? { expertId: form.id } : {}),
    name: form.name.trim(),
    description: form.description.trim(),
    endpointUrl: form.endpointUrl.trim(),
    authType: form.authType,
    interactionMode: form.interactionMode,
    ...(form.credential.trim() ? { credential: form.credential.trim() } : {}),
  }), [adoptId, form]);

  const testConnection = async () => {
    if (!form.name.trim()) return toast.error("请填写专家名称");
    if (!form.endpointUrl.trim()) return toast.error("请填写 A2A 地址");
    setBusyAction("test");
    try {
      const data = await requestJson<{ latencyMs?: number }>("/api/claw/personal-experts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(connectionPayload),
      });
      setConnectionTested(true);
      setConnectionDirty(false);
      const latency = Number(data.latencyMs || 0);
      toast.success(latency > 0 ? `连接成功，响应 ${latency}ms` : "连接成功");
    } catch (error) {
      setConnectionTested(false);
      toast.error(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setBusyAction("");
    }
  };

  const saveExpert = async () => {
    if (!form.name.trim()) return toast.error("请填写专家名称");
    if (!form.endpointUrl.trim()) return toast.error("请填写 A2A 地址");
    if ((!form.id || connectionDirty) && !connectionTested) return toast.error("请先测试连接");
    setBusyAction("save");
    try {
      await requestJson(form.id ? `/api/claw/personal-experts/${form.id}` : "/api/claw/personal-experts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(connectionPayload),
      });
      toast.success(form.id ? "专家已更新" : "专家已添加");
      await loadExperts(true);
      await onChanged?.();
      setView("manage");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "专家保存失败");
    } finally {
      setBusyAction("");
    }
  };

  const mutateExpert = async (id: string, action: "toggle" | "retest" | "delete", enabled?: boolean) => {
    setBusyAction(`${action}:${id}`);
    try {
      if (action === "delete") {
        await requestJson(`/api/claw/personal-experts/${id}?adoptId=${encodeURIComponent(adoptId)}`, { method: "DELETE" });
        toast.success("专家已删除");
      } else {
        await requestJson(`/api/claw/personal-experts/${id}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adoptId, ...(action === "toggle" ? { enabled } : {}) }),
        });
        toast.success(action === "retest" ? "连接测试通过" : `专家已${enabled ? "启用" : "关闭"}`);
      }
      setPendingDeleteId(null);
      await loadExperts(true);
      await onChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusyAction("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="custom-mcp-dialog personal-expert-dialog" showCloseButton={!busyAction}>
        <DialogHeader className="custom-mcp-dialog__header">
          <DialogTitle>{view === "form" ? (form.id ? "编辑专家" : "添加专家") : "管理专家"}</DialogTitle>
          <DialogDescription>
            {view === "form" ? "连接当前岗位可调用的远程 A2A 专家。" : "当前岗位智能体的个人专家。"}
          </DialogDescription>
        </DialogHeader>

        {view === "manage" ? (
          <div className="custom-mcp-manage">
            <div className="custom-mcp-manage__toolbar">
              <span>{experts.length}/{maxExperts} 个专家</span>
              <Button size="sm" onClick={startAdd} disabled={experts.length >= maxExperts || Boolean(busyAction)}>
                <Plus />添加专家
              </Button>
            </div>
            <div className="custom-mcp-list">
              {loading ? (
                <div className="custom-mcp-empty"><LoaderCircle className="animate-spin" />正在加载</div>
              ) : experts.length === 0 ? (
                <div className="custom-mcp-empty"><BrainCircuit />还没有个人专家</div>
              ) : experts.map((expert) => {
                const rowBusy = busyAction.endsWith(`:${expert.id}`);
                return (
                  <div key={expert.id} className="custom-mcp-row" data-enabled={expert.enabled ? "true" : "false"}>
                    <span className="custom-mcp-row__icon" data-status={expert.healthStatus === "healthy" ? "ready" : expert.healthStatus === "offline" ? "error" : "unknown"}>
                      <BrainCircuit />
                    </span>
                    <span className="custom-mcp-row__main">
                      <span className="custom-mcp-row__name">{expert.name}</span>
                      <span className="custom-mcp-row__meta">
                        {endpointHost(expert.endpointUrl)} · {expertStatus(expert)}
                        {expert.interactionMode === "session" ? " · 连续对话" : ""}
                      </span>
                    </span>
                    {pendingDeleteId === expert.id ? (
                      <span className="custom-mcp-row__confirm">
                        <button type="button" onClick={() => setPendingDeleteId(null)}>取消</button>
                        <button type="button" data-danger="true" onClick={() => void mutateExpert(expert.id, "delete")}>删除</button>
                      </span>
                    ) : (
                      <span className="custom-mcp-row__actions">
                        <button type="button" title="重新测试" aria-label="重新测试" disabled={Boolean(busyAction)} onClick={() => void mutateExpert(expert.id, "retest")}>
                          {rowBusy && busyAction.startsWith("retest") ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                        </button>
                        <button type="button" title="编辑" aria-label="编辑" disabled={Boolean(busyAction)} onClick={() => startEdit(expert)}><Pencil /></button>
                        <button type="button" title="删除" aria-label="删除" disabled={Boolean(busyAction)} onClick={() => setPendingDeleteId(expert.id)}><Trash2 /></button>
                        <button
                          type="button"
                          className="custom-mcp-toggle"
                          data-checked={expert.enabled ? "true" : "false"}
                          aria-label={expert.enabled ? "关闭专家" : "启用专家"}
                          aria-pressed={expert.enabled}
                          disabled={Boolean(busyAction)}
                          onClick={() => void mutateExpert(expert.id, "toggle", !expert.enabled)}
                        >
                          {rowBusy && busyAction.startsWith("toggle") ? <LoaderCircle className="animate-spin" /> : <span />}
                        </button>
                      </span>
                    )}
                    {expert.lastError ? <span className="custom-mcp-row__error"><CircleAlert />{expert.lastError}</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="custom-mcp-form personal-expert-form">
            <label>
              <span>专家名称</span>
              <Input value={form.name} maxLength={128} placeholder="例如：合同审查专家" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label>
              <span>专家说明</span>
              <Textarea value={form.description} maxLength={1000} rows={3} placeholder="擅长处理的专业任务" onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
            </label>
            <label>
              <span>A2A 地址</span>
              <Input value={form.endpointUrl} placeholder="https://agent.example.com/a2a" onChange={(event) => updateConnection({ endpointUrl: event.target.value })} />
            </label>
            <label>
              <span>认证方式</span>
              <Select value={form.authType} onValueChange={(value: AuthType) => updateConnection({ authType: value, credential: "" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">无需认证</SelectItem>
                  <SelectItem value="bearer">Bearer Token</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label>
              <span>交互方式</span>
              <Select
                value={form.interactionMode}
                onValueChange={(value: InteractionMode) => setForm((current) => ({ ...current, interactionMode: value }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">单次任务</SelectItem>
                  <SelectItem value="session">连续对话</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {form.authType === "bearer" ? (
              <label>
                <span>Token</span>
                <Input
                  type="password"
                  value={form.credential}
                  autoComplete="new-password"
                  placeholder={form.credentialConfigured ? "已保存，留空不修改" : "输入凭据"}
                  onChange={(event) => updateConnection({ credential: event.target.value })}
                />
              </label>
            ) : null}
            <div className="custom-mcp-test-row">
              <Button type="button" variant="outline" size="sm" disabled={Boolean(busyAction)} onClick={() => void testConnection()}>
                {busyAction === "test" ? <LoaderCircle className="animate-spin" /> : <BrainCircuit />}测试连接
              </Button>
              {connectionTested ? <span><Check />连接已验证</span> : <span>仅支持公网 HTTPS 地址</span>}
            </div>
          </div>
        )}

        <DialogFooter className="custom-mcp-dialog__footer">
          {view === "form" ? (
            <>
              <Button type="button" variant="ghost" onClick={() => setView("manage")} disabled={Boolean(busyAction)}>返回</Button>
              <Button type="button" onClick={() => void saveExpert()} disabled={Boolean(busyAction) || ((!form.id || connectionDirty) && !connectionTested)}>
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
