import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  AlertTriangle,
  BarChart3,
  BriefcaseBusiness,
  Check,
  Compass,
  Database,
  Download,
  FileText,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

type OriginKey = "opensource" | "finance" | "squad";

const CATEGORY_MAP: Record<string, { label: string; Icon: ComponentType<{ size?: number; className?: string }> }> = {
  all: { label: "全部", Icon: Layers },
  writing: { label: "办公效率", Icon: FileText },
  office: { label: "办公效率", Icon: FileText },
  finance: { label: "金融专业", Icon: BarChart3 },
  insurance: { label: "保险业务", Icon: ShieldCheck },
  dev: { label: "开发工具", Icon: Wrench },
  general: { label: "通用", Icon: Sparkles },
  data: { label: "数据分析", Icon: Database },
  bond_trading: { label: "债券交易", Icon: BarChart3 },
  credential_audit: { label: "凭证审核", Icon: FileText },
  auto_insurance_sales: { label: "车险外呼", Icon: ShieldCheck },
  business_audit: { label: "业务审核", Icon: ShieldCheck },
  sales_coaching: { label: "销售陪练", Icon: BriefcaseBusiness },
};

const ORIGIN_META: Record<OriginKey, { label: string; Icon: ComponentType<{ size?: number; className?: string }> }> = {
  opensource: { label: "开源技能", Icon: Compass },
  finance: { label: "金融专业", Icon: BarChart3 },
  squad: { label: "中队专区", Icon: Sparkles },
};

const ROLE_LABELS: Record<string, string> = {
  "investment-researcher": "投顾分析",
  "wealth-manager":        "财富经理",
  "credential-compliance": "审核专员",
  "insurance-advisor":     "保险顾问",
  "general-assistant":     "通用助手",
  "insurance-underwriting":"保险核保",
  "insurance-claims":      "保险理赔",
  "insurance-telesales":   "保险外呼",
  "insurance-ops":         "保险审核",
  "credit-risk":           "风险管理",
  "compliance":            "合规专员",
  "bond-trading":          "债券交易",
  "sales-coaching":        "销售陪练",
};

interface MarketSkill {
  id: number;
  skillId: string;
  title: string;
  description: string;
  author: string;
  installCount: number;
  version: string;
  category: string;
  origin: OriginKey;
  license: string;
  roleTag: string;
  provider: string;
}

const MARKET_CACHE_PREFIX = "employee-agent:skill-market:v9:";
const MARKET_INSTALLED_CACHE_PREFIX = "employee-agent:skill-market-installed:";

function marketCacheKey(adoptId?: string) {
  return `${MARKET_CACHE_PREFIX}${adoptId || "none"}`;
}

function marketInstalledCacheKey(adoptId?: string) {
  return `${MARKET_INSTALLED_CACHE_PREFIX}${adoptId || "none"}`;
}

function categoryMeta(category: string) {
  return CATEGORY_MAP[category] || { label: category || "其他", Icon: BriefcaseBusiness };
}

function marketOriginOf(skill: { origin?: string; category?: string; author?: string; license?: string; skillId?: string }): OriginKey {
  if (skill.origin === "finance") return "finance";
  if (skill.origin === "squad") return "squad";
  if (skill.category === "finance") return "finance";
  return "opensource";
}

function roleChipLabel(item: MarketSkill): string {
  return ROLE_LABELS[item.roleTag] || scenarioTagOf(item);
}

function scenarioTagOf(item: MarketSkill): string {
  const skillId = item.skillId.toLowerCase();
  const category = item.category.toLowerCase();
  const scenarioBySkillId: Record<string, string> = {
    "bond-quote-parse": "债券交易",
    "credential-prompt-generator": "凭证审核",
    "insurance-telesales-recommend": "车险外呼",
    "goldencoach-stage-evaluation": "销售陪练",
  };
  if (scenarioBySkillId[skillId]) return scenarioBySkillId[skillId];
  const meta = categoryMeta(category);
  if (meta.label && meta.label !== "通用") return meta.label;
  return ORIGIN_META[item.origin]?.label || "技能";
}

function skillTitleOf(item: MarketSkill): string {
  return item.title;
}

function normalizeMarketSkills(list: any[]): MarketSkill[] {
  return list.map((s: any) => ({
    id: Number(s.id),
    skillId: String(s.skillId || s.skill_id || ""),
    title: String(s.name || s.skillId || s.skill_id || "未命名技能"),
    description: String(s.description || "暂无说明"),
    author: String(s.author || "官方"),
    installCount: Number(s.downloadCount || s.download_count || 0),
    version: String(s.version || "1.0.0"),
    category: String(s.category || "general"),
    origin: marketOriginOf({
      origin: s.origin,
      category: s.category,
      author: s.author,
      license: s.license,
      skillId: s.skillId || s.skill_id,
    }),
    license: String(s.license || "MIT"),
    roleTag: String(s.roleTag || s.role_tag || ""),
    provider: String(s.provider || ""),
  }));
}

export function MarketplacePage({ adoptId }: { adoptId?: string }) {
  const { confirm, dialog } = useConfirmDialog();
  const [items, setItems] = useState<MarketSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [installing, setInstalling] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [activeOrigin, setActiveOrigin] = useState<OriginKey>("opensource");
  const [activeProviders, setActiveProviders] = useState<Set<string>>(new Set());
  const [activeRoleTags, setActiveRoleTags] = useState<Set<string>>(new Set());
  const [installedMarket, setInstalledMarket] = useState<Record<string, { skillId: string; version?: string }>>({});
  const [selectedSkill, setSelectedSkill] = useState<MarketSkill | null>(null);

  const filterableOrigin = activeOrigin === "finance" || activeOrigin === "squad";
  const originProviders = useMemo(() =>
    [...new Set(items.filter(x => x.origin === activeOrigin).map(x => x.provider).filter(Boolean))].sort()
  , [activeOrigin, items]);

  const originRoleTags = useMemo(() => {
    const keys = [...new Set(items.filter(x => x.origin === activeOrigin && x.roleTag).map(x => x.roleTag))];
    return keys.sort((a, b) => (ROLE_LABELS[a] || a).localeCompare(ROLE_LABELS[b] || b));
  }, [activeOrigin, items]);

  const selectOrigin = (origin: OriginKey) => {
    setActiveOrigin(origin);
    setActiveProviders(new Set());
    setActiveRoleTags(new Set());
  };
  const toggleProvider = (p: string) => setActiveProviders(prev => {
    const next = new Set(prev); next.has(p) ? next.delete(p) : next.add(p); return next;
  });
  const toggleRoleTag = (r: string) => setActiveRoleTags(prev => {
    const next = new Set(prev); next.has(r) ? next.delete(r) : next.add(r); return next;
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    let hasCachedItems = false;

    try {
      const cached = window.localStorage.getItem(marketCacheKey(adoptId));
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          hasCachedItems = true;
          setItems(parsed);
          setLoading(false);
        }
      }
    } catch {}

    setLoadError("");
    if (!hasCachedItems) {
      setItems([]);
      setLoading(true);
    }
    fetch(`/api/claw/skill-market/list?adoptId=${encodeURIComponent(adoptId || "")}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(String(data?.error || `HTTP ${r.status}`));
        return data;
      })
      .then((d) => {
        if (cancelled) return;
        const list = d?.items || d?.result?.data?.json || d?.result?.data || [];
        const normalized = normalizeMarketSkills(Array.isArray(list) ? list : []);
        setItems(normalized);
        try { window.localStorage.setItem(marketCacheKey(adoptId), JSON.stringify(normalized)); } catch {}
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error?.name === "AbortError" ? "请求超时，请重试" : error?.message || "技能广场加载失败");
        }
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [adoptId, reloadVersion]);

  useEffect(() => {
    if (!adoptId) {
      setInstalledMarket({});
      return;
    }
    const cacheKey = marketInstalledCacheKey(adoptId);
    try {
      const cached = window.localStorage.getItem(cacheKey);
      const parsed = cached ? JSON.parse(cached) : null;
      if (parsed && typeof parsed === "object") setInstalledMarket(parsed);
    } catch {}

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    fetch(`/api/claw/skills/registry?adoptId=${encodeURIComponent(adoptId)}`, { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(String(data?.error || `HTTP ${r.status}`));
        return data;
      })
      .then((d) => {
        const rows = Array.isArray(d?.items) ? d.items : [];
        const next: Record<string, { skillId: string; version?: string }> = {};
        for (const skill of rows) {
          if (skill?.source?.kind !== "marketplace") continue;
          const state = String(skill?.state || "");
          if (skill?.enabled === false || state === "disabled" || state === "source_missing") continue;
          const marketId = String(skill?.source?.marketplaceId || "").trim();
          if (!marketId) continue;
          const installedSkillId = String(skill?.id || skill?.source?.skillId || "");
          const installedVersion = String(skill?.source?.version || "");
          next[marketId] = { skillId: installedSkillId, version: installedVersion };
          if (installedSkillId) next[`skill:${installedSkillId}`] = { skillId: installedSkillId, version: installedVersion };
        }
        setInstalledMarket(next);
        try { window.localStorage.setItem(cacheKey, JSON.stringify(next)); } catch {}
      })
      .catch(() => setInstalledMarket((prev) => prev));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [adoptId]);

  const installState = (item: MarketSkill) => {
    const installed = installedMarket[String(item.id)] || installedMarket[`skill:${item.skillId}`];
    const installedVersion = installed?.version || "";
    const canUpdate = !!installed && !!installedVersion && installedVersion !== item.version;
    return { installed, installedVersion, canUpdate };
  };

  const onInstall = async (item: MarketSkill) => {
    if (!adoptId || installing) return;
    setInstalling(item.id);
    try {
      const r = await fetch("/api/trpc/claw.marketInstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { marketId: item.id, adoptId } }),
      });
      const d = await r.json();
      if (d?.error) throw new Error(d.error?.message || "安装失败");
      toast.success(`已安装：${item.title}`);
      const installedSkillId = String(d?.result?.data?.json?.skillId || d?.result?.data?.skillId || item.skillId);
      setInstalledMarket((prev) => {
        const next = {
          ...prev,
          [String(item.id)]: { skillId: installedSkillId, version: item.version },
          [`skill:${installedSkillId}`]: { skillId: installedSkillId, version: item.version },
        };
        try { window.localStorage.setItem(marketInstalledCacheKey(adoptId), JSON.stringify(next)); } catch {}
        return next;
      });
      setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, installCount: (x.installCount || 0) + 1 } : x)));
    } catch (e: any) {
      toast.error(`安装失败${e?.message ? `：${e.message}` : ""}`);
    } finally {
      setInstalling(null);
    }
  };

  const onUninstall = async (item: MarketSkill) => {
    if (!adoptId || installing) return;
    const installed = installedMarket[String(item.id)];
    if (!installed?.skillId) return;
    const ok = await confirm({
      title: "卸载技能？",
      description: `确认卸载 ${item.title}？广场源不会删除，可重新安装。`,
      confirmText: "卸载",
      variant: "danger",
    });
    if (!ok) return;
    setInstalling(item.id);
    try {
      const r = await fetch("/api/claw/skills/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptId, skillId: installed.skillId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.error) throw new Error(d?.error || "卸载失败");
      toast.success(`已卸载：${item.title}`);
      setInstalledMarket((prev) => {
        const next = { ...prev };
        delete next[String(item.id)];
        delete next[`skill:${item.skillId}`];
        try { window.localStorage.setItem(marketInstalledCacheKey(adoptId), JSON.stringify(next)); } catch {}
        return next;
      });
    } catch (e: any) {
      toast.error(`卸载失败${e?.message ? `：${e.message}` : ""}`);
    } finally {
      setInstalling(null);
    }
  };

  const filtered = items.filter((x) => {
    const matchOrigin = x.origin === activeOrigin;
    const matchQ = !q.trim() || `${x.title} ${x.description} ${x.skillId}`.toLowerCase().includes(q.toLowerCase());
    const matchProvider = activeProviders.size === 0 || activeProviders.has(x.provider);
    const matchRole = activeRoleTags.size === 0 || activeRoleTags.has(x.roleTag);
    return matchOrigin && matchQ && matchProvider && matchRole;
  });
  const originCounts = items.reduce<Record<string, number>>((acc, x) => {
    acc[x.origin] = (acc[x.origin] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="skills-market">
      {dialog}
      <div className="skills-market-toolbar">
        <div className="skills-search skills-market-search">
          <Search size={14} className="skills-search-icon" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索技能..." />
        </div>
        <div className="skills-market-categories" aria-label="技能广场来源">
          {(Object.keys(ORIGIN_META) as OriginKey[]).map((origin) => {
            const meta = ORIGIN_META[origin];
            const Icon = meta.Icon;
            const active = activeOrigin === origin;
            const count = originCounts[origin] || 0;
            return (
              <button key={origin} className={`skills-tab ${active ? "active" : ""}`} onClick={() => selectOrigin(origin)}>
                <Icon size={13} />
                {meta.label}
                <span className="skills-market-count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {filterableOrigin && (originProviders.length > 0 || originRoleTags.length > 0) && (
        <div className="skills-market-filters settings-card">
          {originProviders.length > 0 && (
            <div className="skills-market-filter-row">
              <span className="skills-market-filter-label">提供方</span>
              <div className="skills-market-filter-chips">
                {originProviders.map(p => (
                  <button
                    key={p}
                    type="button"
                    className={`skills-filter-chip ${activeProviders.has(p) ? "skills-filter-chip--active" : ""}`}
                    onClick={() => toggleProvider(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
          {originRoleTags.length > 0 && (
            <div className="skills-market-filter-row">
              <span className="skills-market-filter-label">岗位</span>
              <div className="skills-market-filter-chips">
                {originRoleTags.map(r => (
                  <button
                    key={r}
                    type="button"
                    className={`skills-filter-chip ${activeRoleTags.has(r) ? "skills-filter-chip--active" : ""}`}
                    onClick={() => toggleRoleTag(r)}
                  >
                    {ROLE_LABELS[r] || r}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="settings-card skills-market-empty">
          <Loader2 size={20} className="animate-spin" />
          <div>正在加载技能广场...</div>
        </div>
      )}

      {!loading && loadError && (
        <div className="settings-card skills-market-empty" role="alert">
          <AlertTriangle size={22} />
          <div>{items.length > 0 ? "技能列表刷新失败，当前展示上次缓存" : "技能广场加载失败"}</div>
          <div className="skills-muted-text text-xs">{loadError}</div>
          <button className="skills-btn" type="button" onClick={() => setReloadVersion((value) => value + 1)}>
            <RefreshCw size={14} /> 重试
          </button>
        </div>
      )}

      {!loading && !loadError && filtered.length === 0 && (
        <div className="settings-card skills-market-empty">
          <Store size={22} />
          <div>{items.length === 0 ? "技能广场暂无技能" : "没有匹配的技能"}</div>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="skills-market-grid">
          {filtered.map((item) => {
            const meta = categoryMeta(item.category);
            const Icon = meta.Icon;
            const { installed, canUpdate } = installState(item);
            const installLabel = canUpdate ? "更新" : installed ? "已安装" : "安装";
            const title = skillTitleOf(item);
            return (
              <div
                key={item.id}
                className="skills-market-card settings-card"
                role="button"
                tabIndex={0}
                onClick={() => setSelectedSkill(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedSkill(item);
                  }
                }}
              >
                <div className="skills-market-card__head">
                  <div className="skills-market-card__title-wrap">
                    <div className="skills-market-card__title">
                      <Icon size={15} />
                      <span>{title}</span>
                    </div>
                    <div className="skills-market-card__meta">{item.author} · v{item.version}</div>
                  </div>
                  <span className="skills-chip skills-chip--neutral">{roleChipLabel(item)}</span>
                </div>

                <div className="skills-market-card__desc">{item.description}</div>

                <div className="skills-market-card__foot">
                  <span className="skills-market-card__installs"><Download size={12} />{item.installCount} 次安装</span>
                  <button
                    className="skills-btn"
                    disabled={!adoptId || installing === item.id || (!!installed && !canUpdate)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onInstall(item);
                    }}
                  >
                    {installing === item.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : installed && !canUpdate ? (
                      <Check size={12} />
                    ) : (
                      <Download size={12} />
                    )}
                    {installing === item.id ? "安装中" : installLabel}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedSkill && (
        <div className="skills-market-detail" role="dialog" aria-modal="true" aria-label={`${skillTitleOf(selectedSkill)} 详情`}>
          <button className="skills-market-detail__backdrop" type="button" aria-label="关闭详情" onClick={() => setSelectedSkill(null)} />
          <div className="skills-market-detail__panel settings-card">
            {(() => {
              const meta = categoryMeta(selectedSkill.category);
              const Icon = meta.Icon;
              const { installed, installedVersion, canUpdate } = installState(selectedSkill);
              const installLabel = canUpdate ? "更新" : installed ? "已安装" : "安装";
              const title = skillTitleOf(selectedSkill);
              return (
                <>
                  <div className="skills-market-detail__head">
                    <div className="skills-market-detail__icon"><Icon size={18} /></div>
                    <div className="min-w-0">
                      <div className="skills-market-detail__title">{title}</div>
                      <div className="skills-market-detail__meta">{selectedSkill.author} · v{selectedSkill.version}</div>
                    </div>
                    <button className="skills-icon-btn" type="button" aria-label="关闭详情" onClick={() => setSelectedSkill(null)}>
                      <X size={15} />
                    </button>
                  </div>

                  <div className="skills-market-detail__chips">
                    <span className="skills-chip skills-chip--neutral">{roleChipLabel(selectedSkill)}</span>
                    <span className="skills-chip skills-chip--neutral">{meta.label}</span>
                    <span className="skills-chip skills-chip--neutral">{selectedSkill.license}</span>
                    {installed ? (
                      <span className="skills-chip skills-chip--ok"><Check size={12} />已安装{installedVersion ? ` v${installedVersion}` : ""}</span>
                    ) : (
                      <span className="skills-chip skills-chip--neutral">未安装</span>
                    )}
                    {canUpdate && <span className="skills-chip skills-chip--warn">可更新</span>}
                  </div>

                  <div className="skills-market-detail__section">
                    <div className="skills-market-detail__label">说明</div>
                    <div className="skills-market-detail__body">{selectedSkill.description || "暂无说明"}</div>
                  </div>

                  <div className="skills-market-detail__facts">
                    <div><span>安装次数</span><strong>{selectedSkill.installCount}</strong></div>
                    <div><span>技能 ID</span><strong>{selectedSkill.skillId}</strong></div>
                    <div><span>审核</span><strong><ShieldCheck size={12} />静态扫描通过</strong></div>
                  </div>

                  <div className="skills-market-detail__actions">
                    <div className="skills-market-detail__action-buttons">
                      <button
                        className="skills-btn"
                        disabled={!adoptId || installing === selectedSkill.id || (!!installed && !canUpdate)}
                        onClick={() => onInstall(selectedSkill)}
                      >
                        {installing === selectedSkill.id ? <Loader2 size={12} className="animate-spin" /> : installed && !canUpdate ? <Check size={12} /> : <Download size={12} />}
                        {installing === selectedSkill.id ? "安装中" : installLabel}
                      </button>
                      {installed && (
                        <button className="skills-btn skills-btn--ghost" disabled={!adoptId || installing === selectedSkill.id} onClick={() => onUninstall(selectedSkill)}>
                          {installing === selectedSkill.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                          卸载
                        </button>
                      )}
                    </div>
                    <span className="skills-market-detail__hint">
                      安装后会进入“我的技能”，并同步到当前岗位智能体运行时。
                    </span>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
