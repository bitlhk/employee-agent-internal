import { Button } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { invalidateBrandClientCache, useBrand } from "@/lib/useBrand";
import { DEFAULT_BRAND } from "@shared/brand";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export function BrandSettingsPanel() {
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
    onError: (e) => {
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
