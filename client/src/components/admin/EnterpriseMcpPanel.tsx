import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Cable, CheckCircle2, KeyRound, Loader2, Pencil, Plus, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { toast } from "sonner";

type EnterpriseList = RouterOutputs["enterpriseMcp"]["list"];
type EnterpriseConnector = EnterpriseList["items"][number];
type EnterpriseToolPolicy = EnterpriseConnector["policies"][number];
type ConnectorForm = {
  serverId: string;
  displayName: string;
  description: string;
  icon: string;
  businessDomain: string;
  endpointUrl: string;
  resourceUri: string;
  protocolVersion: "2025-11-25" | "2026-07-28";
  identityMode: "platform" | "tenant" | "user";
  authMode: "oauth2_access_token" | "static_bearer_legacy" | "none_shadow";
  credential: string;
  dataClassification: "public" | "internal" | "sensitive" | "restricted";
  environment: "dev" | "test" | "prod";
  lifecycleState: "legacy" | "shadow" | "enforced" | "disabled";
  timeoutMs: number;
  ownerDepartment: string;
  ownerContact: string;
  healthUrl: string;
};

const EMPTY_FORM: ConnectorForm = {
  serverId: "",
  displayName: "",
  description: "",
  icon: "",
  businessDomain: "insurance",
  endpointUrl: "",
  resourceUri: "",
  protocolVersion: "2025-11-25",
  identityMode: "platform",
  authMode: "none_shadow",
  credential: "",
  dataClassification: "internal",
  environment: "prod",
  lifecycleState: "shadow",
  timeoutMs: 30000,
  ownerDepartment: "",
  ownerContact: "",
  healthUrl: "",
};

const LIFECYCLE_LABELS: Record<ConnectorForm["lifecycleState"], string> = {
  legacy: "兼容运行", shadow: "影子接入", enforced: "强制运行", disabled: "已停用",
};
const IDENTITY_LABELS: Record<ConnectorForm["identityMode"], string> = {
  platform: "平台身份", tenant: "租户身份", user: "用户身份",
};
const AUTH_LABELS: Record<ConnectorForm["authMode"], string> = {
  oauth2_access_token: "EA 短期令牌", static_bearer_legacy: "静态 Bearer（过渡）", none_shadow: "无鉴权（仅影子）",
};

function connectorForm(connector?: EnterpriseConnector | null): ConnectorForm {
  if (!connector) return { ...EMPTY_FORM };
  return {
    serverId: connector.serverId,
    displayName: connector.displayName,
    description: connector.description || "",
    icon: connector.icon || "",
    businessDomain: connector.businessDomain,
    endpointUrl: connector.endpointUrl,
    resourceUri: connector.resourceUri,
    protocolVersion: connector.protocolVersion,
    identityMode: connector.identityMode,
    authMode: connector.authMode,
    credential: "",
    dataClassification: connector.dataClassification,
    environment: connector.environment,
    lifecycleState: connector.lifecycleState,
    timeoutMs: connector.timeoutMs,
    ownerDepartment: connector.ownerDepartment || "",
    ownerContact: connector.ownerContact || "",
    healthUrl: connector.healthUrl || "",
  };
}

function policyDraft(policy: EnterpriseToolPolicy) {
  return {
    toolName: policy.toolName,
    enabled: Boolean(policy.enabled),
    sideEffect: policy.sideEffect,
    requiredScopes: Array.isArray(policy.requiredScopes) ? policy.requiredScopes : [],
    allowedRoles: Array.isArray(policy.allowedRoles) ? policy.allowedRoles : null,
    identityModeOverride: policy.identityModeOverride || null,
    approvalMode: policy.approvalMode,
    auditLevel: policy.auditLevel,
    idempotencyRequired: Boolean(policy.idempotencyRequired),
    argumentPolicyJson: policy.argumentPolicyJson && typeof policy.argumentPolicyJson === "object" ? policy.argumentPolicyJson : null,
  };
}

export function EnterpriseMcpPanel() {
  const utils = trpc.useUtils();
  const { data, isLoading, refetch } = trpc.enterpriseMcp.list.useQuery();
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectorForm>({ ...EMPTY_FORM });
  const [rolesTarget, setRolesTarget] = useState<EnterpriseConnector | null>(null);
  const [grantDraft, setGrantDraft] = useState<Record<string, "default" | "optional" | "">>({});
  const [toolsTarget, setToolsTarget] = useState<EnterpriseConnector | null>(null);
  const [toolDrafts, setToolDrafts] = useState<ReturnType<typeof policyDraft>[]>([]);
  const invalidate = async () => utils.enterpriseMcp.list.invalidate();

  const saveMutation = trpc.enterpriseMcp.save.useMutation({
    onSuccess: async () => { toast.success("企业连接器配置已保存"); setEditOpen(false); await invalidate(); },
    onError: error => toast.error(error.message),
  });
  const discoverMutation = trpc.enterpriseMcp.discoverTools.useMutation({
    onSuccess: async result => { toast.success(`连接成功，发现 ${result.tools.length} 个工具`); await invalidate(); },
    onError: error => toast.error(error.message),
  });
  const grantsMutation = trpc.enterpriseMcp.setRoleGrants.useMutation({
    onSuccess: async () => { toast.success("岗位授权已更新"); setRolesTarget(null); await invalidate(); },
    onError: error => toast.error(error.message),
  });
  const policiesMutation = trpc.enterpriseMcp.saveToolPolicies.useMutation({
    onSuccess: async () => { toast.success("工具治理策略已保存"); setToolsTarget(null); await invalidate(); },
    onError: error => toast.error(error.message),
  });

  const openRoles = (connector: EnterpriseConnector) => {
    const next: Record<string, "default" | "optional" | ""> = {};
    for (const grant of connector.grants) next[grant.roleKey] = grant.grantMode;
    setGrantDraft(next);
    setRolesTarget(connector);
  };
  const seedRoleKeys = useMemo(() => new Set(
    (rolesTarget?.grants || []).filter(grant => grant.source === "seed").map(grant => grant.roleKey),
  ), [rolesTarget]);
  const updateTool = (index: number, patch: Partial<ReturnType<typeof policyDraft>>) => {
    setToolDrafts(current => current.map((tool, toolIndex) => toolIndex === index ? { ...tool, ...patch } : tool));
  };
  const connectors = data?.items || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><Cable className="h-5 w-5 text-gray-700" /><h2 className="text-lg font-semibold text-gray-900">企业连接器</h2></div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">统一管理组织 MCP 的地址、可信身份、工具权限和审计策略。无鉴权服务只能以影子模式接入。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isLoading}><RefreshCw className={isLoading ? "animate-spin" : ""} />刷新</Button>
          <Button size="sm" onClick={() => { setEditingId(null); setForm({ ...EMPTY_FORM }); setEditOpen(true); }}><Plus />新增连接器</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-gray-100 py-2 text-xs text-muted-foreground">
        <span className={data?.identityProvider.configured ? "text-green-700" : "text-amber-700"}>{data?.identityProvider.configured ? "短期身份令牌已就绪" : "短期身份令牌未配置"}</span>
        {data?.identityProvider.issuer ? <span className="font-mono">{data.identityProvider.issuer}</span> : null}
        {data?.identityProvider.configured ? <span>{data.identityProvider.keyCount} 把验签公钥</span> : null}
        <span>{data?.identityProvider.unauthenticatedShadowEnabled ? "无鉴权影子调用已开启" : "无鉴权影子调用已关闭"}</span>
      </div>

      <div className="grid gap-3">
        {connectors.map(connector => {
          const ready = connector.healthStatus === "ready";
          return (
            <Card key={connector.serverId} className="gap-0 overflow-hidden py-0">
              <div className="flex flex-col gap-4 p-5 xl:flex-row xl:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50"><Cable className="h-5 w-5 text-gray-700" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-gray-900">{connector.displayName}</h3>
                      <Badge variant="outline" className={ready ? "border-green-200 bg-green-50 text-green-700" : connector.healthStatus === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-gray-200 text-gray-600"}>{ready ? "可连接" : connector.healthStatus === "error" ? "连接异常" : "待检测"}</Badge>
                      <Badge variant="outline" className={connector.lifecycleState === "shadow" ? "border-amber-200 bg-amber-50 text-amber-700" : connector.lifecycleState === "enforced" ? "border-green-200 bg-green-50 text-green-700" : "border-gray-200 text-gray-600"}>{LIFECYCLE_LABELS[connector.lifecycleState]}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-gray-600">{connector.description || "暂无说明"}</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span className="font-mono">{connector.serverId}</span><span>{IDENTITY_LABELS[connector.identityMode]}</span><span>{AUTH_LABELS[connector.authMode]}</span><span>{connector.policies.length} 个工具策略</span><span>{connector.grants.length} 个岗位授权</span></div>
                    <div className="mt-2 truncate font-mono text-[11px] text-gray-400" title={connector.endpointUrl}>{connector.endpointUrl}</div>
                    {connector.lastError ? <div className="mt-2 text-xs text-red-600">{connector.lastError}</div> : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => discoverMutation.mutate({ serverId: connector.serverId })} disabled={discoverMutation.isPending}>{discoverMutation.isPending && discoverMutation.variables?.serverId === connector.serverId ? <Loader2 className="animate-spin" /> : <RefreshCw />}检测</Button>
                  <Button variant="outline" size="sm" onClick={() => { setToolDrafts(connector.policies.map(policyDraft)); setToolsTarget(connector); }}><Wrench />工具策略</Button>
                  <Button variant="outline" size="sm" onClick={() => openRoles(connector)}><ShieldCheck />岗位权限</Button>
                  <Button variant="ghost" size="icon-sm" title="编辑连接器" onClick={() => { setEditingId(connector.serverId); setForm(connectorForm(connector)); setEditOpen(true); }}><Pencil /></Button>
                </div>
              </div>
            </Card>
          );
        })}
        {!isLoading && connectors.length === 0 ? <Card className="items-center gap-2 p-10 text-center"><Cable className="h-6 w-6 text-gray-400" /><div className="text-sm font-medium text-gray-800">暂无企业连接器</div><div className="text-xs text-muted-foreground">新增后可分配给岗位，并对工具逐项设置治理策略。</div></Card> : null}
      </div>

      <ConnectorDialog open={editOpen} editingId={editingId} form={form} setForm={setForm} identityConfigured={Boolean(data?.identityProvider.configured)} pending={saveMutation.isPending} onClose={() => setEditOpen(false)} onSave={() => saveMutation.mutate({ ...form, icon: form.icon || null, clearCredential: form.authMode === "none_shadow" })} />

      <Dialog open={Boolean(rolesTarget)} onOpenChange={open => !open && setRolesTarget(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>岗位权限</DialogTitle><DialogDescription>{rolesTarget?.displayName} 可被哪些岗位发现；基线授权由版本化配置维护。</DialogDescription></DialogHeader>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto py-2">
            {(data?.roles || []).map(role => {
              const fixed = seedRoleKeys.has(role.id);
              const mode = grantDraft[role.id] || "";
              return <div key={role.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2.5">
                <label className="flex min-w-0 items-center gap-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-gray-900" checked={Boolean(mode)} disabled={fixed} onChange={event => setGrantDraft(current => ({ ...current, [role.id]: event.target.checked ? "optional" : "" }))} /><span><span className="font-medium text-gray-800">{role.name}</span><span className="ml-2 font-mono text-[11px] text-gray-400">{role.id}</span></span></label>
                {fixed ? <Badge variant="outline">基线授权</Badge> : mode ? <Select value={mode} onValueChange={value => setGrantDraft(current => ({ ...current, [role.id]: value as "default" | "optional" }))}><SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="optional">可选</SelectItem><SelectItem value="default">默认</SelectItem></SelectContent></Select> : null}
              </div>;
            })}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setRolesTarget(null)}>取消</Button><Button disabled={grantsMutation.isPending || !rolesTarget} onClick={() => rolesTarget && grantsMutation.mutate({ serverId: rolesTarget.serverId, grants: Object.entries(grantDraft).filter(([roleKey, mode]) => Boolean(mode) && !seedRoleKeys.has(roleKey)).map(([roleKey, grantMode]) => ({ roleKey, grantMode: grantMode as "default" | "optional" })) })}>{grantsMutation.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}保存权限</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(toolsTarget)} onOpenChange={open => !open && setToolsTarget(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader><DialogTitle>工具治理策略</DialogTitle><DialogDescription>{toolsTarget?.displayName} 的远端工具必须逐项确认副作用、scope、人工确认方式和审计等级。</DialogDescription></DialogHeader>
          <div className="space-y-3 py-2">
            {toolDrafts.map((tool, index) => <div key={tool.toolName} className="grid gap-3 rounded-lg border border-gray-200 p-3 md:grid-cols-[minmax(180px,1.4fr)_150px_180px_140px]">
              <div className="min-w-0"><label className="flex items-center gap-2 text-sm font-medium text-gray-800"><input type="checkbox" className="h-4 w-4 accent-gray-900" checked={tool.enabled} onChange={event => updateTool(index, { enabled: event.target.checked })} /><span className="truncate font-mono" title={tool.toolName}>{tool.toolName}</span></label><Input className="mt-2 h-8 text-xs" value={tool.requiredScopes.join(", ")} onChange={event => updateTool(index, { requiredScopes: event.target.value.split(",").map(value => value.trim()).filter(Boolean) })} placeholder="scope.one, scope.two" /></div>
              <div className="space-y-1"><Label className="text-xs">副作用</Label><Select value={tool.sideEffect} onValueChange={value => updateTool(index, { sideEffect: value as typeof tool.sideEffect, idempotencyRequired: ["write", "financial_action", "approval_action", "admin_action"].includes(value) || tool.idempotencyRequired })}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="read">只读</SelectItem><SelectItem value="compute">计算</SelectItem><SelectItem value="workspace_write">工作区写入</SelectItem><SelectItem value="write">业务写入</SelectItem><SelectItem value="external_send">外发</SelectItem><SelectItem value="financial_action">金融动作</SelectItem><SelectItem value="approval_action">审批动作</SelectItem><SelectItem value="admin_action">管理动作</SelectItem></SelectContent></Select></div>
              <div className="space-y-1"><Label className="text-xs">人工确认</Label><Select value={tool.approvalMode} onValueChange={value => updateTool(index, { approvalMode: value as typeof tool.approvalMode })}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="never">无需确认</SelectItem><SelectItem value="conditional">按条件确认</SelectItem><SelectItem value="always">每次确认</SelectItem></SelectContent></Select></div>
              <div className="space-y-1"><Label className="text-xs">审计</Label><Select value={tool.auditLevel} onValueChange={value => updateTool(index, { auditLevel: value as typeof tool.auditLevel })}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="normal">普通</SelectItem><SelectItem value="strong">加强</SelectItem><SelectItem value="highest">最高</SelectItem></SelectContent></Select><label className="mt-2 flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" className="accent-gray-900" checked={tool.idempotencyRequired} onChange={event => updateTool(index, { idempotencyRequired: event.target.checked })} />幂等保护</label></div>
            </div>)}
            {toolDrafts.length === 0 ? <div className="rounded-lg bg-gray-50 px-4 py-8 text-center text-sm text-muted-foreground">尚未发现工具，请先执行连接检测。</div> : null}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setToolsTarget(null)}>取消</Button><Button disabled={policiesMutation.isPending || !toolsTarget || toolDrafts.length === 0} onClick={() => toolsTarget && policiesMutation.mutate({ serverId: toolsTarget.serverId, policies: toolDrafts })}>{policiesMutation.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}保存策略</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectorDialog({ open, editingId, form, setForm, identityConfigured, pending, onClose, onSave }: {
  open: boolean;
  editingId: string | null;
  form: ConnectorForm;
  setForm: (form: ConnectorForm) => void;
  identityConfigured: boolean;
  pending: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  return <Dialog open={open} onOpenChange={value => !value && onClose()}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>{editingId ? "编辑企业连接器" : "新增企业连接器"}</DialogTitle><DialogDescription>Server ID 创建后保持稳定；生产连接器应使用 HTTPS Streamable HTTP。</DialogDescription></DialogHeader>
      <div className="grid gap-4 py-2 md:grid-cols-2">
        <Field label="Server ID"><Input value={form.serverId} disabled={Boolean(editingId)} onChange={event => setForm({ ...form, serverId: event.target.value })} placeholder="insurance_customer_profile" /></Field>
        <Field label="显示名称"><Input value={form.displayName} onChange={event => setForm({ ...form, displayName: event.target.value })} /></Field>
        <Field label="说明" wide><Textarea value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></Field>
        <Field label="图标地址" wide><Input value={form.icon} onChange={event => setForm({ ...form, icon: event.target.value })} placeholder="/assets/connectors/example.png" /></Field>
        <Field label="MCP 地址" wide><Input value={form.endpointUrl} onChange={event => setForm({ ...form, endpointUrl: event.target.value, resourceUri: form.resourceUri || event.target.value })} placeholder="https://mcp.example.com/domain/service/mcp" /></Field>
        <Field label="Resource URI / Token audience" wide><Input value={form.resourceUri} onChange={event => setForm({ ...form, resourceUri: event.target.value })} /></Field>
        <Field label="业务域"><Input value={form.businessDomain} onChange={event => setForm({ ...form, businessDomain: event.target.value })} /></Field>
        <Field label="协议版本"><Select value={form.protocolVersion} onValueChange={value => setForm({ ...form, protocolVersion: value as ConnectorForm["protocolVersion"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="2025-11-25">2025-11-25（兼容）</SelectItem><SelectItem value="2026-07-28">2026-07-28（目标）</SelectItem></SelectContent></Select></Field>
        <Field label="身份模式"><Select value={form.identityMode} onValueChange={value => setForm({ ...form, identityMode: value as ConnectorForm["identityMode"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="platform">平台身份</SelectItem><SelectItem value="tenant">租户身份</SelectItem><SelectItem value="user">用户身份</SelectItem></SelectContent></Select></Field>
        <Field label="认证方式"><Select value={form.authMode} onValueChange={value => setForm({ ...form, authMode: value as ConnectorForm["authMode"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none_shadow">无鉴权（仅影子）</SelectItem><SelectItem value="static_bearer_legacy">静态 Bearer（过渡）</SelectItem><SelectItem value="oauth2_access_token">EA 短期令牌</SelectItem></SelectContent></Select></Field>
        {form.authMode === "static_bearer_legacy" ? <Field label={`静态访问令牌${editingId ? "（留空则保持原值）" : ""}`} wide><Input type="password" autoComplete="new-password" value={form.credential} onChange={event => setForm({ ...form, credential: event.target.value })} /></Field> : null}
        <Field label="数据分级"><Select value={form.dataClassification} onValueChange={value => setForm({ ...form, dataClassification: value as ConnectorForm["dataClassification"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="public">公开</SelectItem><SelectItem value="internal">内部</SelectItem><SelectItem value="sensitive">敏感</SelectItem><SelectItem value="restricted">严格受限</SelectItem></SelectContent></Select></Field>
        <Field label="生命周期"><Select value={form.lifecycleState} onValueChange={value => setForm({ ...form, lifecycleState: value as ConnectorForm["lifecycleState"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="shadow">影子接入</SelectItem><SelectItem value="legacy">兼容运行</SelectItem><SelectItem value="enforced">强制运行</SelectItem><SelectItem value="disabled">停用</SelectItem></SelectContent></Select></Field>
        <Field label="所属部门"><Input value={form.ownerDepartment} onChange={event => setForm({ ...form, ownerDepartment: event.target.value })} /></Field>
        <Field label="负责人"><Input value={form.ownerContact} onChange={event => setForm({ ...form, ownerContact: event.target.value })} /></Field>
        <Field label="健康检查地址" wide><Input value={form.healthUrl} onChange={event => setForm({ ...form, healthUrl: event.target.value })} placeholder="https://mcp.example.com/health" /></Field>
        <Field label="超时（毫秒）"><Input type="number" min={1000} max={120000} value={form.timeoutMs} onChange={event => setForm({ ...form, timeoutMs: Number(event.target.value) || 30000 })} /></Field>
        <Field label="环境"><Select value={form.environment} onValueChange={value => setForm({ ...form, environment: value as ConnectorForm["environment"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="dev">开发</SelectItem><SelectItem value="test">测试</SelectItem><SelectItem value="prod">生产</SelectItem></SelectContent></Select></Field>
      </div>
      {form.authMode === "none_shadow" ? <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">当前服务未校验身份，只允许影子接入，不应承载真实敏感数据。</div> : null}
      {form.authMode === "oauth2_access_token" ? <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">{identityConfigured ? "EA 将按用户、岗位、工具和 scope 签发 2 分钟短期令牌；切换强制运行前还需 MCP 服务端完成 JWKS 验签。" : "签名密钥未配置，该连接器不能进入强制运行态。"}</div> : null}
      <DialogFooter><Button variant="outline" onClick={onClose}>取消</Button><Button disabled={pending} onClick={onSave}>{pending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}保存</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <div className={`space-y-2${wide ? " md:col-span-2" : ""}`}><Label>{label}</Label>{children}</div>;
}
