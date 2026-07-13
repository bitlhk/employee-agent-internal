/**
 * ClawAdmin — 智能体管理工作台（独立页面）
 * 风格：白色主题，与灵感官网/ClawHome 一致
 * Tab: 实例管理 / 系统设置 / 组织协作
 */

import { useState, useEffect } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Loader2, ArrowLeft, Search, Users, Settings, RefreshCw, Sparkles, BarChart3, ShieldCheck, Building2, Trash2, KeyRound, UserCog, Activity, Server, Database, Radio, GitBranch, Download, FileText, Eye } from "lucide-react";
import { UsageStatsTab } from "@/components/pages/UsageStatsTab";
import { TenantAuditTab } from "@/components/pages/TenantAuditTab";
import { CollaborationTab } from "@/components/pages/CollaborationTab";
import { toast } from "sonner";
import { useBrand, invalidateBrandClientCache } from "@/lib/useBrand";
import { DEFAULT_BRAND } from "@shared/brand";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { ModelSettingsPanel } from "@/components/admin/ModelSettingsPanel";

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "creating", label: "创建中" },
  { value: "active", label: "启用" },
  { value: "expiring", label: "即将到期" },
  { value: "recycled", label: "停用" },
  { value: "failed", label: "失败" },
] as const;

const PERMISSION_OPTIONS = [
  { value: "plus", label: "员工" },
  { value: "internal", label: "管理员" },
] as const;

const INDUSTRY_LABELS: Record<string, string> = {
  general: "通用",
  banking: "银行",
  insurance: "保险",
  securities: "证券",
};

const formatStatus = (status?: string) =>
  STATUS_OPTIONS.find((s) => s.value === status)?.label || status || "-";

const STATUS_COLORS: Record<string, string> = {
  total: "#6366f1",
  active: "#22c55e",
  creating: "#3b82f6",
  expiring: "#f59e0b",
  recycled: "#9ca3af",
  failed: "#ef4444",
};

const formatBytes = (value?: number) => {
  const n = Number(value || 0);
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const formatPercent = (value?: number) => {
  const n = Number(value || 0);
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
};

const formatUptime = (value?: number) => {
  const n = Number(value || 0);
  if (!n) return "-";
  const diff = Date.now() - n;
  if (diff < 0) return "-";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
};

const formatAuditJson = (value: unknown) => {
  if (value === undefined || value === null) return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getAuditMeta = (event: any, path: string) => {
  const root = event?.metadataJson;
  if (!root || typeof root !== "object") return undefined;
  return path.split(".").reduce<any>((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), root);
};

const auditCategoryLabel = (category?: string) => {
  const map: Record<string, string> = {
    auth: "认证",
    admin: "管理",
    agent: "Agent",
    audit: "审计",
    browser: "浏览器",
    channel: "通道",
    file: "文件",
    mcp: "MCP",
    model: "模型",
    skill: "技能",
    system: "系统",
    tool: "工具",
  };
  return map[String(category || "")] || category || "-";
};

function AuditMetricCard({ title, value, desc }: { title: string; value: number | string; desc: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="mt-1 font-mono text-xl font-semibold text-gray-900">{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{desc}</div>
    </div>
  );
}

const HealthBadge = ({ ok, warn, label }: { ok?: boolean; warn?: boolean; label?: string }) => (
  <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${
    ok ? "border-green-200 bg-green-50 text-green-700" : warn ? "border-yellow-200 bg-yellow-50 text-yellow-700" : "border-red-200 bg-red-50 text-red-700"
  }`}>
    {label || (ok ? "正常" : warn ? "注意" : "异常")}
  </span>
);

const healthStatusLabel = (status: string) => {
  if (status === "ok") return "正常";
  if (status === "warning") return "注意";
  if (status === "disabled") return "未启用";
  return "异常";
};

const healthStatusTone = (status: string) => ({
  ok: status === "ok",
  warn: status === "warning" || status === "disabled",
});

const healthGroupLabel = (group: string) => {
  if (group === "platform") return "平台服务";
  if (group === "runtime") return "Runtime";
  if (group === "channels") return "频道连接";
  if (group === "database") return "数据库";
  if (group === "audit") return "审计";
  return group || "其他";
};

const healthGroupIcon = (group: string) => {
  if (group === "runtime") return Activity;
  if (group === "channels") return Radio;
  if (group === "database") return Database;
  if (group === "audit") return ShieldCheck;
  return Server;
};

const healthGroupHint = (group: string) => {
  if (group === "platform") return "平台进程、资源占用和发布版本。";
  if (group === "runtime") return "外部运行时是否启用、可用，以及近期调用是否正常。";
  if (group === "database") return "平台元数据连接、关键表完整性和查询延迟。";
  if (group === "channels") return "外部消息通道的连接和投递基础状态。";
  if (group === "audit") return "审计账本、失败事件和权限基线。";
  return "系统检查项";
};

type AdminHealthCheck = {
  key?: string;
  group?: string;
  label?: string;
  status?: string;
  detail?: string;
};

function HealthMetricCard({ icon: Icon, title, value, desc, ok, warn }: { icon: any; title: string; value: string; desc?: string; ok?: boolean; warn?: boolean }) {
  return (
    <Card className="admin-panel-card min-w-0 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-700">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{title}</div>
            <div className="mt-1 truncate text-sm font-semibold text-gray-900">{value}</div>
          </div>
        </div>
        <HealthBadge ok={ok} warn={warn} />
      </div>
      {desc ? <div className="mt-3 break-words text-xs leading-5 text-muted-foreground">{desc}</div> : null}
    </Card>
  );
}

const channelKind = (raw: string) => {
  if (/telegram/i.test(raw)) return "Telegram";
  if (/weixin|wechat/i.test(raw)) return "微信";
  return "其他";
};

const summarizeChannels = (lines: any[] = []) => {
  if (!lines.length) return "未配置频道";
  const counts = lines.reduce<Record<string, number>>((acc, line) => {
    const kind = channelKind(String(line?.raw || ""));
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([kind, count]) => `${kind} ${count} 个`).join(" · ");
};

const channelLabel = (raw: string) => {
  const text = String(raw || "");
  const named = text.match(/\(([^)]+)\)/)?.[1];
  if (/telegram/i.test(text)) return "Telegram";
  if (/weixin|wechat/i.test(text)) return named ? `微信：${named}` : "微信通道";
  return text.split(":")[0] || "频道";
};

function BrandSettingsPanel() {
  const brand = useBrand();
  const [form, setForm] = useState({
    name: brand.name,
    nameEn: brand.nameEn,
    platform: brand.platform,
    platformEn: brand.platformEn,
    slogan: brand.slogan,
    accentColor: brand.accentColor,
    logo: brand.logo,
    favicon: brand.favicon,
    systemPrompt: brand.systemPrompt,
    agentIdentity: brand.agentIdentity,
    githubUrl: brand.githubUrl,
    pageTitle: brand.pageTitle,
  });
  const [saving, setSaving] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState(() => {
    return brand.nameEn === DEFAULT_BRAND.nameEn ? "workforce-agent" : "custom";
  });

  const applyPreset = (presetId: string) => {
    setSelectedPreset(presetId);
    if (presetId === "custom") return;
    setForm({ ...DEFAULT_BRAND });
  };

  // Sync from brand when loaded
  useEffect(() => {
    setForm({
      name: brand.name,
      nameEn: brand.nameEn,
      platform: brand.platform,
      platformEn: brand.platformEn,
      slogan: brand.slogan,
      accentColor: brand.accentColor,
      logo: brand.logo,
      favicon: brand.favicon,
      systemPrompt: brand.systemPrompt,
        agentIdentity: brand.agentIdentity,
        githubUrl: brand.githubUrl,
        pageTitle: brand.pageTitle,
    });
    setSelectedPreset(brand.nameEn === DEFAULT_BRAND.nameEn ? "workforce-agent" : "custom");
  }, [brand]);

  const setBrandMutation = trpc.claw.adminSetBrand.useMutation({
    onSuccess: () => {
      invalidateBrandClientCache();
      toast.success("品牌设置已保存，刷新页面后生效");
      setSaving(false);
    },
    onError: (e: any) => {
      toast.error(e?.message || "保存失败");
      setSaving(false);
    },
  });

  const saveBrand = () => {
    setSaving(true);
    setBrandMutation.mutate(form);
  };

  const field = (key: keyof typeof form, label: string, opts?: { type?: string; rows?: number; placeholder?: string }) => (
    <div className="space-y-1" key={key}>
      <Label className="text-sm text-gray-700">{label}</Label>
      {opts?.rows ? (
        <textarea
          className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
          rows={opts.rows}
          value={form[key]}
          onChange={(e) => {
            setSelectedPreset("custom");
            setForm((f) => ({ ...f, [key]: e.target.value }));
          }}
          placeholder={opts?.placeholder}
        />
      ) : (
        <Input
          type={opts?.type || "text"}
          value={form[key]}
          onChange={(e) => {
            setSelectedPreset("custom");
            setForm((f) => ({ ...f, [key]: e.target.value }));
          }}
          placeholder={opts?.placeholder}
        />
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* 模板选择器 */}
      <Card className="p-6 border-border/50 bg-white/80">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">品牌模式</h3>
        <p className="text-xs text-muted-foreground mb-4">默认使用岗位智能体平台品牌；需要企业白标时再切换为自定义。</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            onClick={() => applyPreset("workforce-agent")}
            className="text-left rounded-xl border p-4 transition-all hover:bg-gray-50"
            style={{
              borderColor: selectedPreset === "workforce-agent" ? DEFAULT_BRAND.accentColor : "rgba(0,0,0,0.08)",
              boxShadow: selectedPreset === "workforce-agent" ? `0 0 0 2px ${DEFAULT_BRAND.accentColor}20` : "none",
            }}
          >
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded-full" style={{ background: DEFAULT_BRAND.accentColor }} />
              <span className="text-sm font-semibold text-gray-900">默认岗位智能体</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">恢复岗位智能体名称、Logo、主题色和默认身份。</p>
          </button>
          <button
            onClick={() => setSelectedPreset("custom")}
            className="text-left rounded-xl border p-4 transition-all hover:bg-gray-50"
            style={{
              borderColor: selectedPreset === "custom" ? "#6b7280" : "rgba(0,0,0,0.08)",
              boxShadow: selectedPreset === "custom" ? "0 0 0 2px rgba(107,114,128,0.16)" : "none",
            }}
          >
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded-full border border-gray-300 bg-white" />
              <span className="text-sm font-semibold text-gray-900">自定义</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">按企业部署需要编辑名称、视觉和 AI 身份。</p>
          </button>
        </div>
      </Card>

      <Card className="p-6 space-y-5 border-border/50 bg-white/80">
        <h3 className="text-sm font-semibold text-gray-900">基本信息</h3>
        <div className="grid grid-cols-2 gap-4">
          {field("name", "产品名称（中文）", { placeholder: "岗位智能体" })}
          {field("nameEn", "产品名称（英文）", { placeholder: "Enterprise Agent" })}
          {field("platform", "平台名称（中文）", { placeholder: "岗位智能体" })}
          {field("platformEn", "平台名称（英文）", { placeholder: "Workforce Agent" })}
        </div>
        {field("slogan", "标语")}
        {field("pageTitle", "页面标题")}
      </Card>

      <Card className="p-6 space-y-5 border-border/50 bg-white/80">
        <h3 className="text-sm font-semibold text-gray-900">视觉</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-sm text-gray-700">主题色</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.accentColor}
                onChange={(e) => {
                  setSelectedPreset("custom");
                  setForm((f) => ({ ...f, accentColor: e.target.value }));
                }}
                className="w-10 h-8 rounded border cursor-pointer"
              />
              <Input
                value={form.accentColor}
                onChange={(e) => {
                  setSelectedPreset("custom");
                  setForm((f) => ({ ...f, accentColor: e.target.value }));
                }}
                className="w-28 font-mono text-sm"
              />
            </div>
          </div>
          {field("logo", "Logo 路径", { placeholder: "/images/workforce-agent.svg" })}
        </div>
        {field("favicon", "Favicon 路径", { placeholder: "/favicon.png" })}
      </Card>

      <Card className="p-6 space-y-5 border-border/50 bg-white/80">
        <h3 className="text-sm font-semibold text-gray-900">AI 身份</h3>
        {field("systemPrompt", "System Prompt（英文，安全提示首句）", { rows: 2 })}
        {field("agentIdentity", "Agent 身份自我介绍（中文，写入 SOUL.md）", { rows: 2 })}
      </Card>

      <Card className="p-6 space-y-3 border-border/50 bg-white/80">
        <h3 className="text-sm font-semibold text-gray-900">其他</h3>
        {field("githubUrl", "开源仓库 URL")}
      </Card>

      <div className="flex justify-end">
        <Button onClick={saveBrand} disabled={saving}>
          {saving ? "保存中..." : "保存品牌设置"}
        </Button>
      </div>
    </div>
  );
}

export default function ClawAdmin() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { confirm, dialog } = useConfirmDialog();
  const [activeTab, setActiveTab] = useState("instances");
  const [keyword, setKeyword] = useState("");
  const [viewingSkillId, setViewingSkillId] = useState<number | null>(null);
  const [aiReviewing, setAiReviewing] = useState(false);
  const [skillUploading, setSkillUploading] = useState(false);
  const [aiReviewResult, setAiReviewResult] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<any | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [selectedAuditEvent, setSelectedAuditEvent] = useState<any | null>(null);
  const [assetGrantTarget, setAssetGrantTarget] = useState<any | null>(null);
  const [assetGrantDraft, setAssetGrantDraft] = useState<Record<string, "default" | "optional">>({});
  const [auditPage, setAuditPage] = useState(1);
  const [auditFilters, setAuditFilters] = useState({
    q: "",
    category: "all",
    action: "",
    agentInstanceId: "",
    resourceName: "",
    resourceType: "all",
    toolName: "",
    result: "all",
    severity: "all",
    from: "",
    to: "",
  });

  useEffect(() => {
    const previous = document.body.getAttribute("data-admin-light");
    document.body.setAttribute("data-admin-light", "true");
    return () => {
      if (previous === null) document.body.removeAttribute("data-admin-light");
      else document.body.setAttribute("data-admin-light", previous);
    };
  }, []);

  // ── 实例管理 ──
  const { data: listData, isLoading: listLoading, refetch: refetchList } = trpc.claw.adminList.useQuery(
    { keyword: keyword || undefined, status: statusFilter as any },
    { retry: false }
  );
  const { data: roleTemplates } = trpc.claw.roleTemplates.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  const roleOptions: any[] = ((roleTemplates as any)?.roles || [])
    .filter((role: any) => role?.status !== "disabled")
    .sort((a: any, b: any) => Number(a.displayOrder || 0) - Number(b.displayOrder || 0));
  const roleLabelById = new Map<string, string>(roleOptions.map((role: any) => [String(role.id), String(role.name || role.id)]));
  const formatRole = (roleId?: string): string => roleLabelById.get(String(roleId || "")) || roleId || "普通助手";

  const updateMutation = trpc.claw.adminUpdate.useMutation({
    retry: false,
    onSuccess: () => { refetchList(); toast.success("已更新"); },
    onError: (e: any) => toast.error(e?.message || "更新失败"),
  });

  const deleteMutation = trpc.claw.adminDelete.useMutation({
    retry: false,
    onSuccess: () => { setDeleteTarget(null); refetchList(); toast.success("智能体实例已删除"); },
    onError: (e: any) => toast.error(e?.message || "删除失败"),
  });

  const batchUpdateMutation = trpc.claw.adminBatchUpdate.useMutation({
    retry: false,
    onSuccess: () => { refetchList(); setSelectedIds([]); toast.success("批量更新完成"); },
    onError: (e: any) => toast.error(e?.message || "批量更新失败"),
  });

  // ── 系统配置 ──
  const { data: configData, refetch: refetchConfig } = trpc.claw.adminGetConfig.useQuery(undefined, {
    enabled: activeTab === "settings",
    retry: false,
  });

  const { data: sharedSkills, isLoading: skillsLoading, refetch: refetchSkills } = trpc.claw.adminListSharedSkills.useQuery(undefined, {
    enabled: activeTab === "skills",
    retry: false,
  });

  const { data: marketSkills, isLoading: marketLoading, refetch: refetchMarket } = trpc.claw.adminListMarketSkills.useQuery(undefined, {
    enabled: activeTab === "skills",
    retry: false,
  });
  const { data: roleAssetCatalog, refetch: refetchRoleAssetCatalog } = trpc.claw.adminRoleAssetCatalog.useQuery(undefined, {
    enabled: activeTab === "skills",
    retry: false,
  });
  const roleAssetGrants: any[] = Array.isArray((roleAssetCatalog as any)?.grants) ? (roleAssetCatalog as any).grants : [];
  const mcpRoleAssets: any[] = Array.isArray((roleAssetCatalog as any)?.mcpServers) ? (roleAssetCatalog as any).mcpServers : [];
  const roleGrantOptions = [
    { id: "*", name: "所有岗位", industry: "general", status: "mvp" },
    ...roleOptions,
  ];
  const grantRoleLabel = (roleKey: string) => roleKey === "*" ? "所有岗位" : formatRole(roleKey);
  const assetGrantMutation = trpc.claw.adminSetRoleAssetGrants.useMutation({
    onSuccess: () => {
      refetchRoleAssetCatalog();
      toast.success("岗位授权已更新");
      setAssetGrantTarget(null);
      setAssetGrantDraft({});
    },
    onError: (e: any) => toast.error(e?.message || "岗位授权更新失败"),
  });
  const grantsForAsset = (assetType: "skill" | "mcp_server", assetId: string) =>
    roleAssetGrants.filter((grant: any) => grant.assetType === assetType && grant.assetId === assetId && grant.enabled);
  const openGrantEditor = (assetType: "skill" | "mcp_server", assetId: string, name: string) => {
    const adminGrants = grantsForAsset(assetType, assetId).filter((grant: any) => grant.source === "admin");
    setAssetGrantTarget({ assetType, assetId, name });
    setAssetGrantDraft(Object.fromEntries(adminGrants.map((grant: any) => [grant.roleKey, grant.grantMode === "default" ? "default" : "optional"])));
  };
  const toggleGrantRole = (roleKey: string, checked: boolean) => {
    setAssetGrantDraft((prev) => {
      const next = { ...prev };
      if (checked) next[roleKey] = next[roleKey] || "optional";
      else delete next[roleKey];
      return next;
    });
  };
  const setGrantMode = (roleKey: string, grantMode: "default" | "optional") => {
    setAssetGrantDraft((prev) => ({ ...prev, [roleKey]: grantMode }));
  };
  const saveGrantDraft = () => {
    if (!assetGrantTarget) return;
    assetGrantMutation.mutate({
      assetType: assetGrantTarget.assetType,
      assetId: assetGrantTarget.assetId,
      grants: Object.entries(assetGrantDraft).map(([roleKey, grantMode]) => ({ roleKey, grantMode })),
    });
  };
  const renderGrantSummary = (assetType: "skill" | "mcp_server", assetId: string) => {
    const grants = grantsForAsset(assetType, assetId);
    const visible = grants.slice(0, 4);
    if (!grants.length) return <span className="text-[10px] text-muted-foreground">未配置岗位授权</span>;
    return (
      <span className="inline-flex flex-wrap gap-1">
        {visible.map((grant: any) => (
          <span key={`${grant.source}-${grant.roleKey}`} className={`rounded border px-1.5 py-0.5 text-[10px] ${
            grant.source === "seed" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-amber-200 bg-amber-50 text-amber-700"
          }`}>
            {grantRoleLabel(grant.roleKey)} · {grant.grantMode === "default" ? "默认" : "可选"} · {grant.source}
          </span>
        ))}
        {grants.length > visible.length && <span className="text-[10px] text-muted-foreground">+{grants.length - visible.length}</span>}
      </span>
    );
  };
  const publishSkillMutation = trpc.claw.adminPublishSkill.useMutation({
    onSuccess: () => { refetchMarket(); toast.success("发布成功"); },
    onError: (e: any) => toast.error(e?.message || "发布失败"),
  });
  const reviewSkillMutation = trpc.claw.adminReviewSkill.useMutation({
    onSuccess: () => { refetchMarket(); toast.success("已更新"); },
    onError: (e: any) => toast.error(e?.message || "操作失败"),
  });
  const deleteMarketSkillMutation = trpc.claw.adminDeleteMarketSkill.useMutation({
    onSuccess: () => { refetchMarket(); toast.success("已删除"); },
    onError: (e: any) => toast.error(e?.message || "删除失败"),
  });
  const handleDeleteMarketSkill = async (id: number) => {
    const ok = await confirm({
      title: "删除市场技能？",
      description: "确定删除？",
      confirmText: "删除",
      variant: "danger",
    });
    if (!ok) return;
    deleteMarketSkillMutation.mutate({ id });
  };

  const { data: viewSkillSource, refetch: refetchSkillSource } = trpc.claw.adminViewSkillSource.useQuery(
    { id: viewingSkillId! },
    { enabled: !!viewingSkillId, retry: false }
  );
  const viewSourceFiles = Array.isArray((viewSkillSource as any)?.sourceFiles)
    ? (viewSkillSource as any).sourceFiles
    : [];

  const handleAiReview = async (skillId: number) => {
    setAiReviewing(true);
    setAiReviewResult(null);
    try {
      const res = await fetch("/api/claw/admin/ai-review-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ skillMarketId: skillId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "AI 审核请求失败");
      }
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let result = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const d = JSON.parse(line.slice(6));
              if (d.chunk) { result += d.chunk; setAiReviewResult(result); }
              if (d.done) break;
            } catch {}
          }
        }
      }
      if (!result) setAiReviewResult("未获取到审核结果");
    } catch (e: any) {
      setAiReviewResult("审核失败: " + (e.message || ""));
    } finally {
      setAiReviewing(false);
    }
  };

  const handleSkillUpload = async (file: File) => {
    if (!/\.zip$/i.test(file.name)) {
      toast.error("请上传 .zip 技能包");
      return;
    }
    setSkillUploading(true);
    try {
      const res = await fetch("/api/claw/skill-market/upload", {
        method: "POST",
        headers: { "x-skill-filename": encodeURIComponent(file.name) },
        body: await file.arrayBuffer(),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "上传失败"); return; }
      if (!data.marketItemId) {
        await publishSkillMutation.mutateAsync({
          skillId: data.uploadId || data.name,
          name: data.name,
          description: data.description,
          author: "管理员上传",
          origin: "opensource",
          status: "pending",
        });
      }
      await refetchMarket();
      toast.success(`已上传并进入待审核: ${data.name}`);
    } catch (e: any) {
      toast.error("上传失败: " + (e.message || ""));
    } finally {
      setSkillUploading(false);
    }
  };

  const setConfigMutation = trpc.claw.adminSetConfig.useMutation({
    retry: false,
    onSuccess: () => { refetchConfig(); toast.success("配置已保存"); },
    onError: (e: any) => toast.error(e?.message || "保存失败"),
  });

  const { data: authUsersData, refetch: refetchAuthUsers } = trpc.auth.listUsers.useQuery(undefined, {
    enabled: activeTab === "accounts",
    retry: false,
  });
  const { data: systemHealth, isLoading: systemHealthLoading, refetch: refetchSystemHealth } = trpc.claw.adminSystemHealth.useQuery(undefined, {
    enabled: activeTab === "health",
    retry: false,
    refetchInterval: activeTab === "health" ? 30000 : false,
  });
  const authUsers = Array.isArray(authUsersData) ? authUsersData : [];
  const auditQueryInput = {
    page: auditPage,
    pageSize: 50,
    q: auditFilters.q.trim() || undefined,
    category: auditFilters.category === "all" ? undefined : auditFilters.category,
    action: auditFilters.action.trim() || undefined,
    agentInstanceId: auditFilters.agentInstanceId.trim() || undefined,
    resourceName: auditFilters.resourceName.trim() || undefined,
    resourceType: auditFilters.resourceType === "all" ? undefined : auditFilters.resourceType,
    toolName: auditFilters.toolName.trim() || undefined,
    result: auditFilters.result === "all" ? undefined : auditFilters.result as any,
    severity: auditFilters.severity === "all" ? undefined : auditFilters.severity as any,
    from: auditFilters.from ? new Date(auditFilters.from).toISOString() : undefined,
    to: auditFilters.to ? new Date(auditFilters.to).toISOString() : undefined,
  };
  const { data: auditEventsData, isLoading: auditEventsLoading, refetch: refetchAuditEvents } = trpc.audit.listEvents.useQuery(auditQueryInput, {
    enabled: activeTab === "security-audit",
    retry: false,
  });
  const { data: auditExportsData, refetch: refetchAuditExports } = trpc.audit.listExports.useQuery(undefined, {
    enabled: activeTab === "security-audit",
    retry: false,
  });
  const createAuditExportMutation = trpc.audit.createExport.useMutation({
    onSuccess: (data) => {
      refetchAuditExports();
      refetchAuditEvents();
      toast.success(`导出已生成：${data.rowCount} 行`);
    },
    onError: (e: any) => toast.error(e?.message || "导出失败"),
  });
  const auditRows = Array.isArray((auditEventsData as any)?.rows) ? (auditEventsData as any).rows : [];
  const auditTotal = Number((auditEventsData as any)?.total || 0);
  const auditPageToolCount = auditRows.filter((event: any) => event.category === "mcp" || event.category === "tool" || String(event.action || "").startsWith("mcp.") || String(event.action || "").startsWith("tool.")).length;
  const auditPageFileCount = auditRows.filter((event: any) => event.category === "file" || String(event.action || "").startsWith("file.")).length;
  const auditPageRiskCount = auditRows.filter((event: any) => event.result !== "success" || ["high", "critical"].includes(String(event.severity || ""))).length;
  const auditPageModelCount = auditRows.filter((event: any) => event.category === "model" || String(event.action || "").startsWith("model.")).length;
  const auditExports = Array.isArray(auditExportsData) ? auditExportsData : [];
  const requestAuditExport = (format: "csv" | "json") => {
    const { page: _page, pageSize: _pageSize, ...filters } = auditQueryInput;
    createAuditExportMutation.mutate({ ...filters, format });
  };
  const setUserPasswordMutation = trpc.auth.setUserPassword.useMutation({
    onSuccess: () => {
      toast.success("密码已更新");
      setPasswordTarget(null);
      setNewPassword("");
      refetchAuthUsers();
    },
    onError: (e: any) => toast.error(e?.message || "更新失败"),
  });
  const submitPassword = () => {
    if (!passwordTarget) return;
    setUserPasswordMutation.mutate({ userId: Number(passwordTarget.id), password: newPassword });
  };

  // ── 权限检查 ──
  if (!user || (user as any)?.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-muted-foreground">无权访问管理页面</p>
      </div>
    );
  }

  const summary = listData?.summary;
  const rows = listData?.rows || [];
  const healthData = systemHealth as any;
  const auditHealth = healthData?.audit;
  const auditTables = Array.isArray(auditHealth?.tables) ? auditHealth.tables : [];
  const auditPresentCount = auditTables.filter((table: any) => table.exists).length;
  const auditExpectedCount = auditTables.length || 4;
  const healthChecks: AdminHealthCheck[] = Array.isArray(healthData?.checks) ? healthData.checks : [];
  const healthChecksByGroup: Record<string, AdminHealthCheck[]> = healthChecks.reduce((acc: Record<string, AdminHealthCheck[]>, check: AdminHealthCheck) => {
    const group = String(check?.group || "platform");
    acc[group] = acc[group] || [];
    acc[group].push(check);
    return acc;
  }, {});
  const healthGroupOrder = ["platform", "runtime", "database", "channels", "audit"];
  const healthGroups = healthGroupOrder.map((group) => ({
    group,
    checks: healthChecksByGroup[group] || [],
  }));
  const healthSummary = (healthData?.summary || {}) as any;
  const healthHasErrors = Number(healthSummary.error || 0) > 0;
  const healthHasWarnings = Number(healthSummary.warning || 0) > 0;
  const healthOverallStatus = healthHasErrors ? "error" : healthHasWarnings ? "warning" : "ok";
  const getGroupStatus = (checks: AdminHealthCheck[]) => {
    if (checks.some((check) => check.status === "error")) return "error";
    if (checks.some((check) => check.status === "warning")) return "warning";
    if (checks.length > 0 && checks.every((check) => check.status === "disabled")) return "disabled";
    return "ok";
  };
  const getGroupDetail = (group: string, checks: AdminHealthCheck[]) => {
    const status = getGroupStatus(checks);
    const statusText = healthStatusLabel(status);
    if (group === "platform") {
      const pm2 = healthData?.app?.pm2;
      return `${statusText} · ${pm2?.name || "employee-agent"} · CPU ${formatPercent(pm2?.cpu)} · 内存 ${formatBytes(pm2?.memory)} · 重启 ${pm2?.restarts ?? "-"} 次`;
    }
    if (group === "runtime") {
      const jiuwen = healthData?.runtimes?.jiuwenswarm;
      const openclaw = healthData?.runtimes?.openclaw;
      return `${statusText} · JiuwenSwarm ${jiuwen?.active ?? 0} 个 · OpenClaw ${openclaw?.active ?? 0} 个 · 24h 请求 ${jiuwen?.recent?.requests24h ?? 0}`;
    }
    if (group === "database") {
      const tables = healthData?.database?.tables || [];
      return `${statusText} · 关键表 ${tables.filter((table: any) => table.exists).length}/${tables.length || 4} · 延迟 ${healthData?.database?.latencyMs ?? "-"} ms · 智能体 ${healthData?.database?.claws?.active ?? "-"}`;
    }
    if (group === "channels") {
      const lines = healthData?.channels?.lines || [];
      return lines.length > 0 ? `${statusText} · ${lines.filter((line: any) => line.ok).length}/${lines.length} 运行` : "未接入运行态输出";
    }
    if (group === "audit") {
      return `${statusText} · 表 ${auditPresentCount}/${auditExpectedCount} · DLQ ${auditHealth?.dlq?.eventCount ?? 0} · 最近失败 ${auditHealth?.recentFailures?.length ?? 0}`;
    }
    return checks[0]?.detail || "暂无明细";
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };
  const toggleSelectAll = () => {
    if (selectedIds.length === rows.length) setSelectedIds([]);
    else setSelectedIds(rows.map((r: any) => r.id));
  };

  const navItems = [
    { value: "instances", label: "实例管理", description: "智能体实例与权限", icon: Users },
    { value: "collaboration", label: "组织协作", description: "空间、成员与准入", icon: Building2 },
    { value: "skills", label: "技能广场", description: "上架、审核与共享", icon: Sparkles },
    { value: "usage", label: "使用统计", description: "访问与使用趋势", icon: BarChart3 },
    { value: "accounts", label: "账号管理", description: "管理员与登录密码", icon: UserCog },
    { value: "health", label: "系统健康", description: "平台、Runtime 与连接状态", icon: Activity },
    { value: "security-audit", label: "安全审计", description: "Ledger 查询与导出", icon: ShieldCheck },
    { value: "settings", label: "系统设置", description: "智能体运行配置", icon: Settings },
    { value: "brand", label: "品牌设置", description: "名称、视觉与身份", icon: Sparkles },
    { value: "tenant-audit", label: "隔离审计", description: "租户隔离检查", icon: ShieldCheck },
  ];

  return (
    <div className="claw-admin-shell min-h-screen bg-gradient-to-b from-white to-gray-50/80">
      {dialog}
      {/* Header */}
      <header className="claw-admin-header sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-border/50">
        <div className="container flex items-center justify-between h-14 px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => setLocation("/")} className="claw-admin-back-button">
              <ArrowLeft className="w-4 h-4 mr-1" />
              首页
            </Button>
            <div className="w-px h-5 bg-border" />
            <div className="flex items-center gap-2">
              <BrandIcon size={24} />
              <h1 className="claw-admin-title text-base font-semibold text-gray-900">智能体管理</h1>
            </div>
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="mx-auto w-full max-w-[1440px] p-4 sm:p-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="grid min-w-0 gap-4 lg:gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="claw-admin-sidebar self-start overflow-hidden rounded-2xl border border-gray-200 bg-white/90 p-3 shadow-sm lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
            <div className="px-3 py-2 max-lg:hidden">
              <div className="claw-admin-sidebar-kicker text-xs font-medium uppercase tracking-[0.18em] text-gray-400">Console</div>
              <div className="claw-admin-sidebar-title mt-1 text-sm font-semibold text-gray-900">管理导航</div>
            </div>
            <TabsList className="flex h-auto gap-1 overflow-x-auto bg-transparent p-0 pb-1 lg:mt-2 lg:grid lg:overflow-visible lg:pb-0">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <TabsTrigger
                    key={item.value}
                    value={item.value}
                    className="claw-admin-nav-item group h-auto min-w-[128px] flex-none justify-start rounded-xl border border-transparent px-3 py-2.5 text-left text-gray-600 transition lg:min-w-0 lg:py-3"
                  >
                    <Icon className="claw-admin-nav-icon mr-3 h-4 w-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium leading-none">{item.label}</span>
                      <span className="mt-1 hidden truncate text-[11px] font-normal text-gray-400 group-data-[state=active]:text-red-500 sm:block">{item.description}</span>
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </aside>

          <section className="min-w-0">

          {/* ── 实例管理 ── */}
          <TabsContent value="instances" className="space-y-4">
            {/* 概览 */}
            {summary && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
                {(["total", "active", "creating", "expiring", "recycled", "failed"] as const).map((key) => (
                  <Card key={key} className="p-3 text-center border-border/50 bg-white/80">
                    <p className="text-2xl font-bold" style={{ color: STATUS_COLORS[key] }}>{summary[key]}</p>
                    <p className="text-xs mt-1 text-muted-foreground">
                      {key === "total" ? "总计" : STATUS_OPTIONS.find((s) => s.value === key)?.label || key}
                    </p>
                  </Card>
                ))}
              </div>
            )}

            {/* 搜索 & 过滤 */}
            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="搜索 adoptId / 用户名…"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon" onClick={() => refetchList()} className="text-muted-foreground">
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>

            {/* 批量操作 */}
            {selectedIds.length > 0 && (
              <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20">
                <span className="text-sm font-medium text-gray-700">已选 {selectedIds.length} 项</span>
                <Select onValueChange={(v) => batchUpdateMutation.mutate({ ids: selectedIds, status: v as any })}>
                  <SelectTrigger className="w-28 h-8 text-xs">
                    <SelectValue placeholder="改状态" />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.filter((s) => s.value !== "all").map((s) => (
                      <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select onValueChange={(v) => batchUpdateMutation.mutate({ ids: selectedIds, permissionProfile: v as any })}>
                  <SelectTrigger className="w-28 h-8 text-xs">
                    <SelectValue placeholder="改权限" />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_OPTIONS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select onValueChange={(v) => batchUpdateMutation.mutate({ ids: selectedIds, roleTemplate: v })}>
                  <SelectTrigger className="w-40 h-8 text-xs">
                    <SelectValue placeholder="改岗位" />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((role: any) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}{role.status === "planned" ? "（规划）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])} className="text-muted-foreground">
                  取消
                </Button>
              </div>
            )}

            {/* 列表 */}
            {listLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Card className="border-border/50 bg-white/80 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50/80 border-b border-border/50">
                      <th className="p-3 text-left w-10">
                        <input type="checkbox" checked={selectedIds.length === rows.length && rows.length > 0} onChange={toggleSelectAll} />
                      </th>
                      <th className="p-3 text-left font-medium text-muted-foreground">Adopt ID</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">用户</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">Organization</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">Group</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">状态</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">权限档</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">岗位</th>
                      <th className="p-3 text-left font-medium text-muted-foreground">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row: any) => (
                      <tr key={row.id} className="border-t border-border/30 hover:bg-gray-50/50 transition-colors">
                        <td className="p-3">
                          <input type="checkbox" checked={selectedIds.includes(row.id)} onChange={() => toggleSelect(row.id)} />
                        </td>
                        <td className="p-3 font-mono text-xs text-gray-900">{row.adoptId}</td>
                        <td className="p-3 text-xs text-muted-foreground">{row.userName || row.userEmail || `#${row.userId}`}</td>
                        <td className="p-3 text-xs text-muted-foreground">{row.organizationName || "—"}</td>
                        <td className="p-3 text-xs">
                          {row.userGroupId && row.userGroupId > 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[11px]">
                              <span className="font-medium">{row.groupName || `#${row.userGroupId}`}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">默认/外部</span>
                          )}
                        </td>
                        <td className="p-3">
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLORS[row.status] || "#9ca3af" }} />
                            <span style={{ color: STATUS_COLORS[row.status] || "#6b7280" }}>{formatStatus(row.status)}</span>
                          </span>
                        </td>
                        <td className="p-3">
                          <Select
                            value={row.permissionProfile === "internal" ? "internal" : "plus"}
                            onValueChange={(v) => updateMutation.mutate({ id: row.id, permissionProfile: v as any })}
                          >
                            <SelectTrigger className="h-7 w-24 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PERMISSION_OPTIONS.map((p) => (
                                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="p-3">
                          <Select
                            value={String(row.roleTemplate || "general-assistant")}
                            onValueChange={(v) => updateMutation.mutate({ id: row.id, roleTemplate: v })}
                          >
                            <SelectTrigger className="h-7 w-40 text-xs">
                              <SelectValue placeholder={formatRole(row.roleTemplate)} />
                            </SelectTrigger>
                            <SelectContent>
                              {roleOptions.map((role: any) => (
                                <SelectItem key={role.id} value={role.id}>
                                  {role.name}{role.status === "planned" ? "（规划）" : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-1">
                            {row.status !== "active" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-green-600 hover:text-green-700 hover:bg-green-50"
                                onClick={() => updateMutation.mutate({ id: row.id, status: "active" })}
                              >
                                启用
                              </Button>
                            )}
                            {row.status === "active" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-red-500 hover:text-red-600 hover:bg-red-50"
                                onClick={() => updateMutation.mutate({ id: row.id, status: "recycled" })}
                              >
                                停用
                              </Button>
                            )}
                            {(row.status === "recycled" || row.status === "failed") && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                                disabled={deleteMutation.isPending}
                                onClick={() => setDeleteTarget(row)}
                              >
                                <Trash2 size={13} />
                                删除
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="p-8 text-center text-muted-foreground">暂无数据</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>
            )}
          </TabsContent>

          {/* ── 系统设置 ── */}
          <TabsContent value="settings" className="space-y-6">
            <Card className="p-6 space-y-5 border-border/50 bg-white/80">
              <h3 className="text-sm font-semibold text-gray-900">智能体配置</h3>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm text-gray-700">可见性</Label>
                    <p className="text-xs mt-0.5 text-muted-foreground">public = 所有注册用户可创建，internal = 仅白名单用户</p>
                  </div>
                  <Select
                    value={configData?.visibility || "internal"}
                    onValueChange={(v) => setConfigMutation.mutate({ visibility: v as any })}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">Public</SelectItem>
                      <SelectItem value="internal">Internal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="h-px bg-border/50" />

                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm text-gray-700">默认角色</Label>
                    <p className="text-xs mt-0.5 text-muted-foreground">角色用于智能体层管理，底层运行时按岗位模板同步技能、MCP 与权限配置</p>
                  </div>
                  <Select
                    value={configData?.defaultProfile === "internal" ? "internal" : "plus"}
                    onValueChange={(v) => setConfigMutation.mutate({ defaultProfile: v as any })}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="plus">员工</SelectItem>
                      <SelectItem value="internal">管理员</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Card>
            <ModelSettingsPanel enabled={activeTab === "settings"} />
          </TabsContent>

          {/* ── 品牌设置 ── */}
          <TabsContent value="brand" className="space-y-6">
            <BrandSettingsPanel />
          </TabsContent>

          {/* ── 技能广场 ── */}
          <TabsContent value="skills" className="space-y-4">
            {/* 上传区 */}
            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">上传共享技能</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">管理员上传的 .zip 技能包解析后进入待审核，可按来源展示到“开源技能”“金融专业”或“中队专区”</p>
                </div>
              </div>
              <div
                className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors hover:border-primary/40"
                onClick={() => document.getElementById("skill-upload-input")?.click()}
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "var(--primary)"; }}
                onDragLeave={(e) => { e.currentTarget.style.borderColor = ""; }}
                onDrop={async (e) => {
                  e.preventDefault();
                  e.currentTarget.style.borderColor = "";
                  if (skillUploading) return;
                  const file = e.dataTransfer.files[0];
                  if (!file) return;
                  await handleSkillUpload(file);
                }}
              >
                <p className="text-sm text-muted-foreground">{skillUploading ? "正在上传并解析技能包..." : "拖拽 .zip 文件到此处，或点击选择"}</p>
                <input id="skill-upload-input" type="file" accept=".zip" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file && !skillUploading) await handleSkillUpload(file);
                  e.target.value = "";
                }} />
              </div>
            </Card>

            {/* 广场技能列表 */}
            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">技能广场管理</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">审核、上下架、管理广场中的共享技能</p>
                </div>
                <Button size="sm" variant="outline" className="admin-secondary-action" onClick={() => refetchMarket()}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />刷新
                </Button>
              </div>
              {marketLoading ? (
                <div className="flex items-center gap-2 py-6 justify-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
              ) : (
                <div className="space-y-2">
                  {(marketSkills || []).map((item: any) => {
                    const catLabels: any = { finance: "金融", dev: "开发", data: "数据", writing: "写作", general: "通用" };
                    const originLabels: any = { opensource: "开源技能", finance: "金融专业", squad: "中队专区" };
                    const originLabel = item.origin === "finance" || (item.origin === "opensource" && item.category === "finance")
                      ? "金融专业"
                      : (originLabels[item.origin || "opensource"] || item.origin || "开源技能");
                    const stLabels: any = { pending: "待审核", approved: "已上架", rejected: "已拒绝", offline: "已下架" };
                    const stColors: any = { pending: "bg-yellow-50 text-yellow-700 border-yellow-200", approved: "bg-green-50 text-green-700 border-green-200", rejected: "bg-red-50 text-red-700 border-red-200", offline: "bg-gray-50 text-gray-500 border-gray-200" };
                    return (
                      <div key={item.id} className="border rounded-lg p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-gray-900">{item.name}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-mono">{item.skillId}</span>
                              <span className={"text-[10px] px-1.5 py-0.5 rounded border font-medium " + (stColors[item.status] || "")}>{stLabels[item.status] || item.status}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700">{originLabel}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-600">{catLabels[item.category] || item.category}</span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">{item.description || "—"}</div>
                            <div className="mt-2">{renderGrantSummary("skill", item.skillId)}</div>
                            <div className="text-[10px] text-muted-foreground mt-1">
                              v{item.version} · {item.author} · {item.license} · 安装 {item.downloadCount} 次
                              {item.reviewNote && <span className="ml-2 text-yellow-600">审核备注: {item.reviewNote}</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Button size="sm" variant="outline" className="admin-secondary-action h-7 text-xs" onClick={() => openGrantEditor("skill", item.skillId, item.name)}>
                              岗位授权
                            </Button>
                            <Button size="sm" variant="outline" className="admin-secondary-action h-7 text-xs" onClick={() => {
                              setViewingSkillId(item.id);
                              setAiReviewResult(null);
                            }}>查看源码</Button>
                            <Button size="sm" variant="outline" className="admin-secondary-action h-7 text-xs" disabled={aiReviewing} onClick={() => {
                              setViewingSkillId(item.id);
                              handleAiReview(item.id);
                            }}>{aiReviewing ? "AI审核中…" : "AI 审核"}</Button>
                            {item.status === "pending" && (
                              <>
                                <Button size="sm" className="admin-success-action h-7 text-xs" onClick={() => reviewSkillMutation.mutate({ id: item.id, status: "approved" })}>通过</Button>
                                <Button size="sm" variant="destructive" className="admin-danger-action h-7 text-xs" onClick={() => {
                                  const note = prompt("拒绝原因：");
                                  if (note !== null) reviewSkillMutation.mutate({ id: item.id, status: "rejected", reviewNote: note || "不符合要求" });
                                }}>拒绝</Button>
                              </>
                            )}
                            {item.status === "approved" && (
                              <Button size="sm" variant="outline" className="admin-secondary-action h-7 text-xs" onClick={() => reviewSkillMutation.mutate({ id: item.id, status: "offline" })}>下架</Button>
                            )}
                            {(item.status === "offline" || item.status === "rejected") && (
                              <Button size="sm" variant="outline" className="admin-secondary-action h-7 text-xs" onClick={() => reviewSkillMutation.mutate({ id: item.id, status: "approved" })}>重新上架</Button>
                            )}
                            <Button size="sm" variant="ghost" className="admin-danger-ghost-action h-7 text-xs" onClick={() => { void handleDeleteMarketSkill(item.id); }}>删除</Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {(!marketSkills || marketSkills.length === 0) && (
                    <div className="text-xs text-center py-6 text-muted-foreground">暂无广场技能，从上方上传添加</div>
                  )}
                </div>
              )}
            </Card>

            {/* MCP 岗位授权 */}
            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">MCP 岗位授权</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">按 server 级别给岗位授权；可见即时生效，默认装配随新建或岗位重置生效</p>
                </div>
                <Button size="sm" variant="outline" className="admin-secondary-action" onClick={() => refetchRoleAssetCatalog()}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />刷新
                </Button>
              </div>
              <div className="space-y-2">
                {mcpRoleAssets.map((server: any) => (
                  <div key={server.serverId} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900">{server.name || server.serverId}</span>
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600">{server.serverId}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${
                          server.enabled ? "border-green-200 bg-green-50 text-green-700" : "border-gray-200 bg-gray-50 text-gray-500"
                        }`}>{server.enabled ? "可用" : server.status || "未启用"}</span>
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground">{server.groupName || "MCP"}</div>
                      <div className="mt-2">{renderGrantSummary("mcp_server", server.serverId)}</div>
                    </div>
                    <Button size="sm" variant="outline" className="admin-secondary-action h-7 text-xs" onClick={() => openGrantEditor("mcp_server", server.serverId, server.name || server.serverId)}>
                      岗位授权
                    </Button>
                  </div>
                ))}
                {mcpRoleAssets.length === 0 && (
                  <div className="py-6 text-center text-xs text-muted-foreground">暂无 MCP server 可授权</div>
                )}
              </div>
            </Card>

            <Dialog open={!!assetGrantTarget} onOpenChange={(open) => {
              if (!open) {
                setAssetGrantTarget(null);
                setAssetGrantDraft({});
              }
            }}>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>岗位授权</DialogTitle>
                  <DialogDescription>
                    {assetGrantTarget?.name || assetGrantTarget?.assetId} · {assetGrantTarget?.assetId}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3">
                    <div className="text-xs font-medium text-blue-900">基线授权</div>
                    <div className="mt-2">
                      {assetGrantTarget ? renderGrantSummary(assetGrantTarget.assetType, assetGrantTarget.assetId) : null}
                    </div>
                    <div className="mt-1 text-[11px] text-blue-700">seed 行来自基线，只能通过文档/配置变更调整；这里保存的是 admin 动态授权。</div>
                  </div>
                  <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                    {roleGrantOptions.map((role: any) => {
                      const roleKey = String(role.id);
                      const checked = Boolean(assetGrantDraft[roleKey]);
                      return (
                        <div key={roleKey} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                          <label className="flex min-w-0 flex-1 items-center gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => toggleGrantRole(roleKey, e.target.checked)}
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-gray-900">{role.name || roleKey}</span>
                              <span className="block text-[10px] text-muted-foreground">
                                {roleKey} · {INDUSTRY_LABELS[String(role.industry || "general")] || role.industry || "通用"}
                                {role.status === "planned" ? " · 规划" : ""}
                              </span>
                            </span>
                          </label>
                          <Select
                            value={assetGrantDraft[roleKey] || "optional"}
                            disabled={!checked}
                            onValueChange={(value) => setGrantMode(roleKey, value === "default" ? "default" : "optional")}
                          >
                            <SelectTrigger className="h-8 w-24 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="optional">可选</SelectItem>
                              <SelectItem value="default">默认</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => {
                    setAssetGrantTarget(null);
                    setAssetGrantDraft({});
                  }}>取消</Button>
                  <Button onClick={saveGrantDraft} disabled={assetGrantMutation.isPending}>
                    {assetGrantMutation.isPending ? "保存中…" : "保存动态授权"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* 源码查看弹窗 */}
            {viewingSkillId && (
              <Card className="admin-panel-card p-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-900">源码查看</h3>
                  <Button size="sm" variant="outline" className="admin-secondary-action h-7 text-xs" onClick={() => setViewingSkillId(null)}>关闭</Button>
                </div>
                {viewSkillSource ? (
                  <div>
                    <div className="text-xs font-medium text-gray-700 mb-1">SKILL.md</div>
                    <pre className="text-xs bg-gray-50 border rounded-lg p-3 overflow-auto max-h-64 whitespace-pre-wrap">{viewSkillSource.skillMd || "(无)"}</pre>
                    {viewSourceFiles.length > 0 ? (
                      <div className="mt-4 space-y-3">
                        <div className="text-xs font-medium text-gray-700">源码文件</div>
                        {viewSourceFiles.map((file: any) => (
                          <div key={file.path} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                            <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-3 py-2">
                              <span className="min-w-0 truncate font-mono text-[11px] text-gray-700">{file.path}</span>
                              <span className="shrink-0 text-[10px] text-gray-400">{file.size} bytes</span>
                            </div>
                            <pre className="max-h-72 overflow-auto bg-gray-50/60 p-3 text-xs font-mono text-gray-800 whitespace-pre">{file.content || "(空文件)"}</pre>
                          </div>
                        ))}
                      </div>
                    ) : viewSkillSource.scripts?.length > 0 ? (
                      <div className="mt-4">
                        <div className="text-xs font-medium text-gray-700 mb-1">脚本文件</div>
                        <div className="flex flex-wrap gap-1.5">
                          {viewSkillSource.scripts.map((s: string) => (
                            <span key={s} className="text-[10px] px-2 py-1 rounded bg-blue-50 text-blue-700 font-mono">{s}</span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs text-muted-foreground">暂无脚本源码文件</div>
                    )}
                    <div className="text-[10px] text-muted-foreground mt-2">路径: {viewSkillSource.dir}</div>
                    {aiReviewResult && (
                      <div className="mt-3">
                        <div className="text-xs font-medium text-gray-700 mb-1">AI 审核意见</div>
                        <div className="text-xs bg-blue-50 border border-blue-200 rounded-lg p-3 whitespace-pre-wrap max-h-48 overflow-auto">{aiReviewResult}</div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-4 text-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground inline-block" /></div>
                )}
              </Card>
            )}
          </TabsContent>

          <TabsContent value="collaboration" className="space-y-4">
            <CollaborationTab />
          </TabsContent>
          <TabsContent value="usage" className="space-y-4">            <UsageStatsTab />          </TabsContent>
          <TabsContent value="accounts" className="space-y-4">
            <Card className="admin-panel-card p-6">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">账号管理</h2>
                  <p className="mt-1 text-xs text-muted-foreground">管理登录用户和管理员密码。</p>
                </div>
                <Button size="sm" variant="outline" className="admin-secondary-action" onClick={() => refetchAuthUsers()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  刷新
                </Button>
              </div>

              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                <div className="grid grid-cols-[72px_minmax(160px,1fr)_120px_160px] border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-medium text-gray-500">
                  <span>ID</span>
                  <span>邮箱</span>
                  <span>角色</span>
                  <span>操作</span>
                </div>
                {authUsers.length > 0 ? authUsers.map((u: any) => (
                  <div key={u.id} className="grid grid-cols-[72px_minmax(160px,1fr)_120px_160px] items-center border-b border-gray-100 px-4 py-3 text-sm last:border-b-0">
                    <span className="font-mono text-xs text-gray-500">{u.id}</span>
                    <span className="truncate text-gray-900">{u.email || "-"}</span>
                    <span>
                      <span className={`rounded-full px-2 py-1 text-xs ${u.role === "admin" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-600"}`}>
                        {u.role === "admin" ? "管理员" : "用户"}
                      </span>
                    </span>
                    <span>
                      <Button type="button" variant="outline" size="sm" className="admin-secondary-action h-8" onClick={() => {
                        setPasswordTarget(u);
                        setNewPassword("");
                      }}>
                        <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                        改密码
                      </Button>
                    </span>
                  </div>
                )) : (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无登录用户</div>
                )}
              </div>
            </Card>
          </TabsContent>
          <TabsContent value="health" className="space-y-4">
            <Card className="admin-panel-card p-6">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">系统健康</h2>
                  <p className="mt-1 text-xs text-muted-foreground">只读监测平台服务、Runtime、频道、模型配置和数据库关键表。</p>
                </div>
                <Button size="sm" variant="outline" className="admin-secondary-action" onClick={() => refetchSystemHealth()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  刷新
                </Button>
              </div>

              {systemHealthLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在检查系统状态
                </div>
              ) : systemHealth ? (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <HealthBadge {...healthStatusTone(healthOverallStatus)} label={healthStatusLabel(healthOverallStatus)} />
                      <div className="text-xs text-muted-foreground">
                        检查时间 <span className="font-mono text-gray-700">{new Date((systemHealth as any).checkedAt).toLocaleString("zh-CN")}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span>异常 <span className="font-mono text-red-600">{healthSummary.error ?? 0}</span></span>
                      <span>注意 <span className="font-mono text-yellow-700">{healthSummary.warning ?? 0}</span></span>
                      <span>未启用 <span className="font-mono text-gray-700">{healthSummary.disabled ?? 0}</span></span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {healthGroups.map(({ group, checks }) => {
                      const Icon = healthGroupIcon(group);
                      const groupStatus = getGroupStatus(checks);
                      const groupTone = healthStatusTone(groupStatus);
                      return (
                        <Card key={group} className="gap-0 overflow-hidden py-0">
                          <details className="group">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-2.5">
                              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                                <Icon className="h-4 w-4 shrink-0 text-gray-500" />
                                <h3 className="shrink-0 text-sm font-semibold text-gray-900">{healthGroupLabel(group)}</h3>
                                <span className="shrink-0 text-xs text-muted-foreground">{checks.length} 项</span>
                                <span className="min-w-0 truncate text-xs text-muted-foreground">{getGroupDetail(group, checks)}</span>
                              </div>
                              <HealthBadge ok={groupTone.ok} warn={groupTone.warn} label={healthStatusLabel(groupStatus)} />
                            </summary>
                            <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-4">
                              <div className="mb-3 text-xs text-muted-foreground">{healthGroupHint(group)}</div>
                              <div className="space-y-2">
                                {checks.map((check) => {
                                  const tone = healthStatusTone(String(check.status || ""));
                                  return (
                                    <div key={check.key || check.label} className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs">
                                      <div className="min-w-0">
                                        <div className="font-medium text-gray-800">{check.label || check.key}</div>
                                        <div className="mt-1 break-words text-muted-foreground">{check.detail || "-"}</div>
                                      </div>
                                      <HealthBadge ok={tone.ok} warn={tone.warn} label={healthStatusLabel(String(check.status || "error"))} />
                                    </div>
                                  );
                                })}
                                {checks.length === 0 ? (
                                  <div className="rounded-lg bg-white px-3 py-3 text-center text-xs text-muted-foreground">暂无检查项</div>
                                ) : null}
                              </div>

                              {group === "platform" ? (
                                <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                                  <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">代码分支</span><div className="mt-1 font-mono text-gray-800">{(systemHealth as any).app?.git?.branch || "-"}</div></div>
                                  <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">代码提交</span><div className="mt-1 font-mono text-gray-800">{(systemHealth as any).app?.git?.commit || "-"}</div></div>
                                  <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">平台运行</span><div className="mt-1 font-mono text-gray-800">{formatUptime((systemHealth as any).app?.pm2?.uptime)}</div></div>
                                  <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">重启次数</span><div className="mt-1 font-mono text-gray-800">{(systemHealth as any).app?.pm2?.restarts ?? "-"}</div></div>
                                </div>
                              ) : null}

                              {group === "runtime" ? (
                                <div className="mt-3 space-y-3">
                                  <div className="grid gap-2 text-xs md:grid-cols-3">
                                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">主 Runtime</span><div className="mt-1 font-mono text-gray-800">{(systemHealth as any).runtimes?.primary || "-"}</div></div>
                                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">JiuwenSwarm 会话</span><div className="mt-1 font-mono text-gray-800">{(systemHealth as any).runtimes?.jiuwenswarm?.globalSessions ?? "-"}</div></div>
                                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">模型配置</span><div className="mt-1 font-mono text-gray-800">{((systemHealth as any).models?.allowlist || []).length} 可用 · {((systemHealth as any).models?.agentModelDrift || []).length} 漂移</div></div>
                                  </div>
                                  {((systemHealth as any).models?.agentModelDrift || []).length > 0 ? (
                                    <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                                      有 {((systemHealth as any).models?.agentModelDrift || []).length} 个智能体保存的模型不在当前可用模型内。
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}

                              {group === "database" ? (
                                <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                                  <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">查询延迟</span><div className="mt-1 font-mono text-gray-800">{(systemHealth as any).database?.latencyMs ?? "-"} ms</div></div>
                                  <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">关键表</span><div className="mt-1 font-mono text-gray-800">{((systemHealth as any).database?.tables || []).filter((table: any) => table.exists).length}/{((systemHealth as any).database?.tables || []).length || 4}</div></div>
                                  <div className="rounded-lg border border-gray-200 bg-white px-3 py-2"><span className="text-muted-foreground">业务对象</span><div className="mt-1 font-mono text-gray-800">智能体 {(systemHealth as any).database?.claws?.active ?? "-"} · 技能 {(systemHealth as any).database?.skillMarketApproved ?? "-"}</div></div>
                                </div>
                              ) : null}

                              {group === "channels" ? (
                                <div className="mt-3 space-y-2">
                                  {((systemHealth as any).channels?.lines || []).map((line: any, index: number) => (
                                    <div key={`${line.raw}-${index}`} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs">
                                      <span className="min-w-0 truncate text-gray-700">{channelLabel(line.raw)}</span>
                                      <HealthBadge ok={line.ok} warn={line.warn} />
                                    </div>
                                  ))}
                                  {((systemHealth as any).channels?.lines || []).length === 0 ? (
                                    <div className="rounded-lg bg-white px-3 py-3 text-center text-xs text-muted-foreground">暂无频道输出</div>
                                  ) : null}
                                </div>
                              ) : null}

                              {group === "audit" && auditHealth ? (
                                <div className="mt-3 space-y-4">
                                  <div className="grid gap-3 lg:grid-cols-4">
                                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs"><div className="text-muted-foreground">Rows</div><div className="mt-1 font-mono text-sm font-semibold text-gray-900">{auditHealth.ledger?.rowCount ?? 0}</div></div>
                                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs"><div className="text-muted-foreground">Oldest</div><div className="mt-1 font-mono text-[11px] text-gray-900">{auditHealth.ledger?.oldestEventTime ? new Date(auditHealth.ledger.oldestEventTime).toLocaleString("zh-CN") : "-"}</div></div>
                                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs"><div className="text-muted-foreground">Newest</div><div className="mt-1 font-mono text-[11px] text-gray-900">{auditHealth.ledger?.newestEventTime ? new Date(auditHealth.ledger.newestEventTime).toLocaleString("zh-CN") : "-"}</div></div>
                                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs"><div className="text-muted-foreground">DLQ</div><div className="mt-1 font-mono text-sm font-semibold text-gray-900">{auditHealth.dlq?.eventCount ?? 0} events · {formatBytes(auditHealth.dlq?.bytes)}</div></div>
                                  </div>
                                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                                    <div className="grid grid-cols-[minmax(180px,1fr)_80px_90px_minmax(130px,160px)_minmax(130px,160px)] border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500"><span>Table</span><span>Status</span><span>Rows</span><span>Oldest</span><span>Newest</span></div>
                                    {auditTables.map((table: any) => (
                                      <div key={table.name} className="grid grid-cols-[minmax(180px,1fr)_80px_90px_minmax(130px,160px)_minmax(130px,160px)] items-center border-b border-gray-100 px-3 py-2 text-xs last:border-b-0"><span className="font-mono text-gray-800">{table.name}</span><span><HealthBadge ok={table.exists} label={table.exists ? "exists" : "missing"} /></span><span className="font-mono text-gray-700">{table.rowCount ?? "-"}</span><span className="font-mono text-[11px] text-gray-600">{table.oldest ? new Date(table.oldest).toLocaleDateString("zh-CN") : "-"}</span><span className="font-mono text-[11px] text-gray-600">{table.newest ? new Date(table.newest).toLocaleDateString("zh-CN") : "-"}</span></div>
                                    ))}
                                  </div>
                                  <div className="grid gap-4 xl:grid-cols-2">
                                    <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs"><div className="mb-2 flex items-center justify-between"><span className="font-semibold text-gray-900">数据库权限基线</span><HealthBadge ok={Boolean(auditHealth.permissions?.ok)} warn={!auditHealth.permissions?.ok} /></div><div className="text-muted-foreground">权限项 {auditHealth.permissions?.grantCount ?? 0}</div>{(auditHealth.permissions?.forbiddenPrivileges || []).length > 0 ? (<div className="mt-2 flex flex-wrap gap-1.5">{auditHealth.permissions.forbiddenPrivileges.map((priv: string) => <span key={priv} className="rounded-full bg-red-50 px-2 py-1 font-mono text-[11px] text-red-700">{priv}</span>)}</div>) : <div className="mt-2 text-muted-foreground">未发现高危权限。</div>}</div>
                                    <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs"><div className="mb-2 flex items-center justify-between"><span className="font-semibold text-gray-900">Recent Failures</span><span className="text-muted-foreground">{auditHealth.recentFailures?.length || 0}</span></div>{(auditHealth.recentFailures || []).slice(0, 3).map((event: any) => (<div key={event.eventId} className="mb-2 rounded-lg bg-gray-50 px-3 py-2 last:mb-0"><div className="truncate font-mono text-gray-800">{event.action}</div><div className="mt-1 text-[11px] text-muted-foreground">{event.result} · {event.severity} · {event.eventTime ? new Date(event.eventTime).toLocaleString("zh-CN") : "-"}</div></div>))}{(auditHealth.recentFailures || []).length === 0 ? <div className="rounded-lg bg-gray-50 px-3 py-3 text-center text-muted-foreground">No failure events</div> : null}</div>
                                  </div>
                                  {(auditHealth.warnings || []).length > 0 ? <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{auditHealth.warnings.join(" · ")}</div> : null}
                                </div>
                              ) : null}
                            </div>
                          </details>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg bg-gray-50 px-4 py-8 text-center text-sm text-muted-foreground">暂无健康数据</div>
              )}
            </Card>
          </TabsContent>
          <TabsContent value="security-audit" className="space-y-4">
            <Card className="admin-panel-card p-6">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">安全审计</h2>
                  <p className="mt-1 text-xs text-muted-foreground">查询 Enterprise Audit Ledger，并生成短期受控导出文件。</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="admin-secondary-action" onClick={() => { refetchAuditEvents(); refetchAuditExports(); }}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    刷新
                  </Button>
                  <Button size="sm" variant="outline" className="admin-secondary-action" disabled={createAuditExportMutation.isPending} onClick={() => requestAuditExport("json")}>
                    <FileText className="mr-1.5 h-3.5 w-3.5" />
                    JSON
                  </Button>
                  <Button size="sm" disabled={createAuditExportMutation.isPending} onClick={() => requestAuditExport("csv")}>
                    {createAuditExportMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
                    CSV
                  </Button>
                </div>
              </div>

              <div className="mb-4 grid gap-3 md:grid-cols-4">
                <AuditMetricCard title="当前结果" value={auditTotal} desc="匹配当前过滤条件的审计事件" />
                <AuditMetricCard title="风险事件" value={auditPageRiskCount} desc="当前页失败、拒绝或高危事件" />
                <AuditMetricCard title="MCP / 工具" value={auditPageToolCount} desc="当前页 MCP 与 OpenClaw 工具事件" />
                <AuditMetricCard title="文件 / 模型" value={`${auditPageFileCount}/${auditPageModelCount}`} desc="当前页文件操作 / 模型调用事件" />
              </div>

              <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-8">
                <div className="xl:col-span-2">
                  <Label className="text-xs">关键词</Label>
                  <Input
                    value={auditFilters.q}
                    onChange={(e) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, q: e.target.value })); }}
                    placeholder="event/action/email/target/hash"
                    className="mt-1 h-9"
                  />
                </div>
                <div>
                  <Label className="text-xs">Category</Label>
                  <Select value={auditFilters.category} onValueChange={(value) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, category: value })); }}>
                    <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部</SelectItem>
                      <SelectItem value="auth">auth</SelectItem>
                      <SelectItem value="admin">admin</SelectItem>
                      <SelectItem value="agent">agent</SelectItem>
                      <SelectItem value="channel">channel</SelectItem>
                      <SelectItem value="file">file</SelectItem>
                      <SelectItem value="mcp">mcp</SelectItem>
                      <SelectItem value="model">model</SelectItem>
                      <SelectItem value="skill">skill</SelectItem>
                      <SelectItem value="tool">tool</SelectItem>
                      <SelectItem value="browser">browser</SelectItem>
                      <SelectItem value="audit">audit</SelectItem>
                      <SelectItem value="system">system</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Action</Label>
                  <Input
                    value={auditFilters.action}
                    onChange={(e) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, action: e.target.value })); }}
                    placeholder="auth.login.success"
                    className="mt-1 h-9"
                  />
                </div>
                <div>
                  <Label className="text-xs">Agent</Label>
                  <Input
                    value={auditFilters.agentInstanceId}
                    onChange={(e) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, agentInstanceId: e.target.value })); }}
                    placeholder="adoptId / agentId"
                    className="mt-1 h-9"
                  />
                </div>
                <div>
                  <Label className="text-xs">Tool</Label>
                  <Input
                    value={auditFilters.toolName}
                    onChange={(e) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, toolName: e.target.value })); }}
                    placeholder="mcp/tool name"
                    className="mt-1 h-9"
                  />
                </div>
                <div>
                  <Label className="text-xs">Resource</Label>
                  <Input
                    value={auditFilters.resourceName}
                    onChange={(e) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, resourceName: e.target.value })); }}
                    placeholder="文件路径 / MCP server"
                    className="mt-1 h-9"
                  />
                </div>
                <div>
                  <Label className="text-xs">资源类型</Label>
                  <Select value={auditFilters.resourceType} onValueChange={(value) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, resourceType: value })); }}>
                    <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部</SelectItem>
                      <SelectItem value="workspace_file">workspace_file</SelectItem>
                      <SelectItem value="mcp_server">mcp_server</SelectItem>
                      <SelectItem value="openclaw_tool">openclaw_tool</SelectItem>
                      <SelectItem value="agent">agent</SelectItem>
                      <SelectItem value="audit_export">audit_export</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Result</Label>
                  <Select value={auditFilters.result} onValueChange={(value) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, result: value })); }}>
                    <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部</SelectItem>
                      <SelectItem value="success">success</SelectItem>
                      <SelectItem value="failed">failed</SelectItem>
                      <SelectItem value="denied">denied</SelectItem>
                      <SelectItem value="warning">warning</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Severity</Label>
                  <Select value={auditFilters.severity} onValueChange={(value) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, severity: value })); }}>
                    <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部</SelectItem>
                      <SelectItem value="info">info</SelectItem>
                      <SelectItem value="low">low</SelectItem>
                      <SelectItem value="medium">medium</SelectItem>
                      <SelectItem value="high">high</SelectItem>
                      <SelectItem value="critical">critical</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">开始</Label>
                  <Input type="datetime-local" value={auditFilters.from} onChange={(e) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, from: e.target.value })); }} className="mt-1 h-9" />
                </div>
                <div>
                  <Label className="text-xs">结束</Label>
                  <Input type="datetime-local" value={auditFilters.to} onChange={(e) => { setAuditPage(1); setAuditFilters((prev) => ({ ...prev, to: e.target.value })); }} className="mt-1 h-9" />
                </div>
              </div>

              <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>共 {auditTotal} 条，当前第 {auditPage} 页</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="h-8" disabled={auditPage <= 1} onClick={() => setAuditPage((p) => Math.max(1, p - 1))}>上一页</Button>
                  <Button size="sm" variant="outline" className="h-8" disabled={auditPage * 50 >= auditTotal} onClick={() => setAuditPage((p) => p + 1)}>下一页</Button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                <div className="grid min-w-[1240px] grid-cols-[170px_86px_230px_90px_90px_minmax(160px,1fr)_minmax(180px,1fr)_minmax(130px,190px)_74px] border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500">
                  <span>Time</span><span>Type</span><span>Action</span><span>Result</span><span>Risk</span><span>Actor / Target</span><span>Resource</span><span>Agent / Tool</span><span>Detail</span>
                </div>
                {auditEventsLoading ? (
                  <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载审计事件
                  </div>
                ) : auditRows.length > 0 ? auditRows.map((event: any) => (
                  <div key={event.eventId} className="grid min-w-[1240px] grid-cols-[170px_86px_230px_90px_90px_minmax(160px,1fr)_minmax(180px,1fr)_minmax(130px,190px)_74px] items-center border-b border-gray-100 px-3 py-2 text-xs last:border-b-0">
                    <span className="font-mono text-[11px] text-gray-600">{event.eventTime ? new Date(event.eventTime).toLocaleString("zh-CN") : "-"}</span>
                    <span className="truncate text-gray-700">{auditCategoryLabel(event.category)}</span>
                    <span className="truncate font-mono text-gray-900" title={event.action}>{event.action}</span>
                    <span><HealthBadge ok={event.result === "success"} warn={event.result === "warning"} label={event.result} /></span>
                    <span className="font-mono text-gray-700">{event.severity}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-gray-800">{event.actorEmail || event.actorName || event.actorUserId || event.actorType}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{event.targetType || "-"}:{event.targetName || event.targetId || "-"}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-gray-800" title={event.resourceName || event.resourceId || ""}>{event.resourceName || event.resourceId || "-"}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{event.resourceType || "-"}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[11px] text-gray-700">{event.agentInstanceId || event.runtimeAgentId || "-"}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{event.toolName || "-"}</span>
                    </span>
                    <span>
                      <Button size="sm" variant="outline" className="h-8 w-8 p-0" title="查看详情" onClick={() => setSelectedAuditEvent(event)}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </div>
                )) : (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无审计事件</div>
                )}
              </div>
            </Card>

            <Card className="admin-panel-card p-6">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">导出记录</h3>
                  <p className="mt-1 text-xs text-muted-foreground">下载会重新校验权限、过期时间和文件哈希，并写入下载审计事件。</p>
                </div>
              </div>
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                <div className="grid min-w-[760px] grid-cols-[minmax(180px,1fr)_80px_90px_120px_170px_110px] border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500">
                  <span>Export</span><span>Format</span><span>Rows</span><span>Size</span><span>Expires</span><span>Action</span>
                </div>
                {auditExports.length > 0 ? auditExports.map((item: any) => (
                  <div key={item.exportId} className="grid min-w-[760px] grid-cols-[minmax(180px,1fr)_80px_90px_120px_170px_110px] items-center border-b border-gray-100 px-3 py-2 text-xs last:border-b-0">
                    <span className="truncate font-mono text-gray-800">{item.exportId}</span>
                    <span className="font-mono text-gray-700">{item.format}</span>
                    <span className="font-mono text-gray-700">{item.rowCount}</span>
                    <span className="font-mono text-gray-700">{formatBytes(item.fileSizeBytes)}</span>
                    <span className="font-mono text-[11px] text-gray-600">{item.expiresAt ? new Date(item.expiresAt).toLocaleString("zh-CN") : "-"}</span>
                    <span>
                      <Button size="sm" variant="outline" className="h-8" onClick={() => { window.location.href = item.downloadUrl; }}>
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                        下载
                      </Button>
                    </span>
                  </div>
                )) : (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无导出记录</div>
                )}
              </div>
            </Card>
          </TabsContent>
          <TabsContent value="tenant-audit" className="space-y-4">            <TenantAuditTab />          </TabsContent>
          </section>
        </Tabs>
      </main>
      <Dialog open={!!selectedAuditEvent} onOpenChange={(open) => { if (!open) setSelectedAuditEvent(null); }}>
        <DialogContent className="max-h-[85vh] overflow-hidden border-border/60 bg-white p-0 shadow-xl sm:max-w-3xl">
          <DialogHeader className="border-b border-border/60 px-5 py-4">
            <DialogTitle className="text-base font-semibold text-gray-900">审计事件详情</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {selectedAuditEvent?.eventId || "-"}
            </DialogDescription>
          </DialogHeader>
          {selectedAuditEvent ? (
            <div className="max-h-[68vh] overflow-y-auto px-5 py-4">
              <div className="grid gap-3 md:grid-cols-2">
                {[
                  ["Time", selectedAuditEvent.eventTime ? new Date(selectedAuditEvent.eventTime).toLocaleString("zh-CN") : "-"],
                  ["Category", selectedAuditEvent.category],
                  ["Action", selectedAuditEvent.action],
                  ["Result", selectedAuditEvent.result],
                  ["Severity", selectedAuditEvent.severity],
                  ["Actor", selectedAuditEvent.actorEmail || selectedAuditEvent.actorName || selectedAuditEvent.actorUserId || selectedAuditEvent.actorType || "-"],
                  ["Target", `${selectedAuditEvent.targetType || "-"}:${selectedAuditEvent.targetName || selectedAuditEvent.targetId || "-"}`],
                  ["Resource", `${selectedAuditEvent.resourceType || "-"}:${selectedAuditEvent.resourceName || selectedAuditEvent.resourceId || "-"}`],
                  ["Agent", selectedAuditEvent.agentInstanceId || selectedAuditEvent.runtimeAgentId || "-"],
                  ["Request", selectedAuditEvent.requestId || "-"],
                  ["Correlation", selectedAuditEvent.correlationId || "-"],
                  ["IP", selectedAuditEvent.ip || "-"],
                  ["Error Code", selectedAuditEvent.errorCode || "-"],
                  ["Policy Code", selectedAuditEvent.policyCode || "-"],
                  ["Risk Type", selectedAuditEvent.riskType || "-"],
                  ["Tool", selectedAuditEvent.toolName || "-"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
                    <div className="text-muted-foreground">{label}</div>
                    <div className="mt-1 break-words font-mono text-gray-900">{String(value || "-")}</div>
                  </div>
                ))}
              </div>
              {(selectedAuditEvent.category === "mcp" || selectedAuditEvent.category === "tool" || String(selectedAuditEvent.action || "").startsWith("mcp.") || String(selectedAuditEvent.action || "").startsWith("tool.")) ? (
                <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/50 p-4">
                  <div className="mb-3 text-xs font-semibold text-blue-900">工具 / MCP 调用</div>
                  <div className="grid gap-3 md:grid-cols-3">
                    {[
                      ["Server", selectedAuditEvent.resourceName || selectedAuditEvent.resourceId || "-"],
                      ["Tool", selectedAuditEvent.toolName || selectedAuditEvent.targetName || "-"],
                      ["Host", getAuditMeta(selectedAuditEvent, "endpointHost") || "-"],
                      ["Args Hash", getAuditMeta(selectedAuditEvent, "args.argsHash") || "-"],
                      ["Args Bytes", getAuditMeta(selectedAuditEvent, "args.argsBytes") ?? "-"],
                      ["Duration", getAuditMeta(selectedAuditEvent, "durationMs") ? `${getAuditMeta(selectedAuditEvent, "durationMs")} ms` : "-"],
                      ["Response Bytes", getAuditMeta(selectedAuditEvent, "responseBytes") ?? "-"],
                      ["Fields", Array.isArray(getAuditMeta(selectedAuditEvent, "args.fieldNames")) ? getAuditMeta(selectedAuditEvent, "args.fieldNames").join(", ") : "-"],
                      ["Message Bytes", getAuditMeta(selectedAuditEvent, "args.messageBytes") ?? "-"],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-blue-100 bg-white px-3 py-2 text-xs">
                        <div className="text-blue-700/70">{label}</div>
                        <div className="mt-1 break-words font-mono text-blue-950">{String(value || "-")}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {(selectedAuditEvent.category === "file" || String(selectedAuditEvent.action || "").startsWith("file.")) ? (
                <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50/50 p-4">
                  <div className="mb-3 text-xs font-semibold text-emerald-900">文件操作</div>
                  <div className="grid gap-3 md:grid-cols-3">
                    {[
                      ["Filename", getAuditMeta(selectedAuditEvent, "filename") || selectedAuditEvent.targetName || "-"],
                      ["Path", getAuditMeta(selectedAuditEvent, "path") || selectedAuditEvent.resourceName || "-"],
                      ["Ext", getAuditMeta(selectedAuditEvent, "ext") || "-"],
                      ["Size", getAuditMeta(selectedAuditEvent, "sizeBytes") ? formatBytes(Number(getAuditMeta(selectedAuditEvent, "sizeBytes"))) : "-"],
                      ["SHA256", getAuditMeta(selectedAuditEvent, "sha256") || selectedAuditEvent.resourceId || "-"],
                      ["Runtime", selectedAuditEvent.runtimeType || "-"],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-emerald-100 bg-white px-3 py-2 text-xs">
                        <div className="text-emerald-700/70">{label}</div>
                        <div className="mt-1 break-words font-mono text-emerald-950">{String(value || "-")}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {(selectedAuditEvent.category === "model" || String(selectedAuditEvent.action || "").startsWith("model.")) ? (
                <div className="mt-4 rounded-xl border border-purple-100 bg-purple-50/50 p-4">
                  <div className="mb-3 text-xs font-semibold text-purple-900">模型调用</div>
                  <div className="grid gap-3 md:grid-cols-3">
                    {[
                      ["Provider", getAuditMeta(selectedAuditEvent, "provider") || "-"],
                      ["Model", getAuditMeta(selectedAuditEvent, "model") || selectedAuditEvent.resourceName || "-"],
                      ["Reasoning", String(getAuditMeta(selectedAuditEvent, "reasoning") ?? "-")],
                      ["Duration", getAuditMeta(selectedAuditEvent, "durationMs") ? `${getAuditMeta(selectedAuditEvent, "durationMs")} ms` : "-"],
                      ["Tokens", getAuditMeta(selectedAuditEvent, "tokens") ? JSON.stringify(getAuditMeta(selectedAuditEvent, "tokens")) : "-"],
                      ["Channel", selectedAuditEvent.channel || "-"],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-purple-100 bg-white px-3 py-2 text-xs">
                        <div className="text-purple-700/70">{label}</div>
                        <div className="mt-1 break-words font-mono text-purple-950">{String(value || "-")}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="mt-4">
                <div className="mb-2 text-xs font-semibold text-gray-900">Metadata</div>
                <pre className="max-h-80 overflow-auto rounded-lg border border-gray-200 bg-gray-950 p-3 text-xs leading-5 text-gray-100">
                  {formatAuditJson(selectedAuditEvent.metadataJson)}
                </pre>
                {selectedAuditEvent.metadataTruncated ? (
                  <div className="mt-2 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                    metadata 已截断，导出文件同样只包含截断后的安全内容。
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <DialogFooter className="border-t border-border/60 px-5 py-4">
            <Button variant="outline" onClick={() => setSelectedAuditEvent(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent className="border-border/60 bg-white p-0 shadow-xl sm:max-w-md">
          <AlertDialogHeader>
            <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <AlertDialogTitle className="text-base font-semibold text-gray-900">确认删除这个智能体实例？</AlertDialogTitle>
                <AlertDialogDescription className="mt-1 text-xs leading-5 text-muted-foreground">
              删除后会清理智能体实例工作空间、个人技能注册和后台设置；协作记录与审计记录会保留。这个操作只允许对已停用或失败的智能体实例执行。
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          {deleteTarget && (
            <div className="mx-5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Adopt ID: <span className="font-mono text-gray-900">{deleteTarget.adoptId}</span>
            </div>
          )}
          <AlertDialogFooter className="border-t border-border/60 px-5 py-4">
            <AlertDialogCancel className="h-9 border-gray-200 text-gray-700 hover:bg-gray-50" disabled={deleteMutation.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="h-9 bg-red-600 text-white hover:bg-red-700 focus:ring-red-200"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate({ id: deleteTarget.id });
              }}
            >
              {deleteMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={!!passwordTarget} onOpenChange={(open) => {
        if (!open) {
          setPasswordTarget(null);
          setNewPassword("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改登录密码</DialogTitle>
            <DialogDescription>
              为 {passwordTarget?.email || "该用户"} 设置新的登录密码。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="claw-admin-new-password">新密码</Label>
            <Input
              id="claw-admin-new-password"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newPassword.length >= 6) submitPassword();
              }}
              autoComplete="new-password"
              placeholder="至少 6 位"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => {
              setPasswordTarget(null);
              setNewPassword("");
            }}>
              取消
            </Button>
            <Button
              type="button"
              onClick={submitPassword}
              disabled={newPassword.length < 6 || setUserPasswordMutation.isPending}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
