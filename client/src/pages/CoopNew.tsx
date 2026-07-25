/**
 * CoopNew — 发起多人协作
 *
 * 两种形态：
 *   - <CoopNewForm />  嵌入式（CollabPage 内 list↔create 切换；onDone / onCancel 回调）
 *   - <CoopNew />      独立路由 /coop/new（薄壳：sticky header + 自己管 navigation）
 *
 * 纯表单逻辑放在 CoopNewForm，独立路由只提供 wrapper 和默认回调。
 *
 * 流程：
 *   1. 选模板 / 填协作标题 / 原始消息 / 汇总预设
 *   2. 选人（从 coop.mentionCandidates 拉候选，按 group 过滤）
 *   3. 每人一个子任务（默认 = 原始消息 或 模板 memberPrompt）
 *   4. 发起 → coop.create → onDone(sessionId)
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Users as UsersIcon, Search, UserPlus, X, Sparkles } from "lucide-react";
import { COOP_TEMPLATES, getTemplateById, renderVars } from "@/data/coopTemplates";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

type Candidate = {
  userId: number;
  userName: string | null;
  userEmail: string | null;
  groupId: number | null;
  groupName: string | null;
  orgName: string | null;
  departmentName: string | null;
  teamName: string | null;
  adoptId: string | null;
  adoptionStatus: string | null;
};

type SelectedMember = {
  cand: Candidate;
  subtask: string;
};

type PrefillPayload = {
  origin?: string;
  title?: string;
  members?: Array<{ userId: number; userName?: string | null; adoptId?: string | null }>;
};

type CoopNewFormProps = {
  /** 发起成功的回调；接收新 sessionId。独立页默认导航到 /coop/:sid，嵌入页可切回 list 或也跳 */
  onDone?: (sessionId: string) => void;
  /** "取消 / 返回" 的回调。独立页 history.back，嵌入页 setMode("list") */
  onCancel?: () => void;
};

export function CoopNewForm({ onDone, onCancel }: CoopNewFormProps) {
  const { confirm, dialog } = useConfirmDialog();
  const { user } = useAuth();
  const selfUserId = user?.id;
  const [title, setTitle] = useState("");
  const [originMessage, setOriginMessage] = useState("");
  const [consolidationPromptPreset, setConsolidationPromptPreset] = useState("");
  const [templateId, setTemplateId] = useState<string>("blank");
  const [keyword, setKeyword] = useState("");
  const [groupFilter, setGroupFilter] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState<SelectedMember[]>([]);

  // 预填来源：主聊天 @ ≥2 人后跳转过来时，sessionStorage 里的 coop_prefill
  // 包含 origin（原始消息）+ members（已 @ 的 userId 列表）
  // 候选拉回后再匹配预选成员（async 时序）
  const [pendingPrefillMembers, setPendingPrefillMembers] = useState<PrefillPayload["members"]>(undefined);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("coop_prefill");
      if (!raw) return;
      const p: PrefillPayload = JSON.parse(raw);
      if (p.origin) {
        setOriginMessage(p.origin);
        setTitle((p.title || p.origin).slice(0, 80).split(/\n/)[0]);
      }
      if (p.members?.length) setPendingPrefillMembers(p.members);
      sessionStorage.removeItem("coop_prefill");
    } catch {}
  }, []);

  // 查白名单状态
  const wlQ = trpc.coop.isWhitelisted.useQuery();
  // 候选人列表
  const { data: rawCandidates, isLoading: candLoading } = trpc.coop.mentionCandidates.useQuery(
    { keyword: keyword || undefined, groupId: groupFilter, limit: 200 },
    { enabled: Boolean(wlQ.data?.whitelisted) }
  );
  const createMut = trpc.coop.create.useMutation({
    onSuccess: (r) => {
      toast.success("协作已发起");
      onDone?.(r.sessionId);
    },
    onError: (e) => toast.error(e.message || "发起失败"),
  });

  // 候选拉回后，匹配预填的 members（来自主聊天 @ 跳转）
  useEffect(() => {
    if (!pendingPrefillMembers?.length) return;
    if (!rawCandidates) return;
    const candById = new Map<number, Candidate>();
    (rawCandidates as Candidate[]).forEach((c) => candById.set(c.userId, c));
    const matched: SelectedMember[] = [];
    const missing: string[] = [];
    for (const m of pendingPrefillMembers) {
      const c = candById.get(m.userId);
      if (c) {
        matched.push({ cand: c, subtask: originMessage });
      } else {
        missing.push(m.userName || `user#${m.userId}`);
      }
    }
    if (matched.length > 0) setSelected(matched);
    if (missing.length > 0) toast.warning(`部分成员未在候选列表中: ${missing.join(", ")}`);
    setPendingPrefillMembers(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawCandidates, pendingPrefillMembers]);

  const groups = useMemo(() => {
    const map = new Map<number, string>();
    (rawCandidates || []).forEach((c: Candidate) => {
      if (c.groupId && c.groupName) map.set(c.groupId, c.groupName);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [rawCandidates]);

  const candidates = useMemo(() => {
    const excludedIds = new Set(selected.map((s) => s.cand.userId));
    const list = (rawCandidates || []).filter((c: Candidate) => !excludedIds.has(c.userId));
    if (selfUserId !== undefined) {
      list.sort((a, b) => (a.userId === selfUserId ? -1 : b.userId === selfUserId ? 1 : 0));
    }
    return list;
  }, [rawCandidates, selected, selfUserId]);

  const pickCandidate = (c: Candidate) => {
    setSelected((prev) => [...prev, { cand: c, subtask: originMessage }]);
  };
  const unpickCandidate = (uid: number) => {
    setSelected((prev) => prev.filter((s) => s.cand.userId !== uid));
  };
  const updateSubtask = (uid: number, v: string) => {
    setSelected((prev) => prev.map((s) => (s.cand.userId === uid ? { ...s, subtask: v } : s)));
  };

  // origin 变化时，未手动改过的子任务跟随更新
  const [prevOrigin, setPrevOrigin] = useState(originMessage);
  useEffect(() => {
    if (prevOrigin === originMessage) return;
    setSelected((prev) => prev.map((s) => (s.subtask === prevOrigin ? { ...s, subtask: originMessage } : s)));
    setPrevOrigin(originMessage);
  }, [originMessage, prevOrigin]);

  const { data: myClawData } = trpc.claw.me.useQuery(undefined, { retry: false });
  const creatorAdoptId = (myClawData as any)?.adoptId || "lgc-creator";

  const canSubmit =
    title.trim().length > 0 &&
    originMessage.trim().length > 0 &&
    selected.length >= 1 &&
    selected.every((s) => s.subtask.trim().length > 0);

  const handleSubmit = () => {
    const preset = consolidationPromptPreset.trim();
    createMut.mutate({
      title: title.trim(),
      originMessage: originMessage.trim(),
      consolidationPromptPreset: preset ? preset : undefined,
      creatorAdoptId,
      members: selected.map((s) => ({
        userId: s.cand.userId,
        targetAdoptId: s.cand.adoptId || `mock:${s.cand.userId}`,
        subtask: s.subtask.trim(),
      })),
    });
  };

  const selfCand = useMemo(
    () => (rawCandidates as Candidate[] | undefined)?.find((c) => c.userId === selfUserId),
    [rawCandidates, selfUserId]
  );

  const formatCandidateOrg = (c: Candidate) => {
    const parts = [c.orgName, c.departmentName, c.teamName].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : "—";
  };

  // 应用模板 — 整块重置，不走 prevOrigin 跟随逻辑
  const applyTemplate = async (id: string) => {
    if (id === templateId) return;
    const tpl = getTemplateById(id);
    if (!tpl) return;

    const hasAnyInput =
      title.trim().length > 0 ||
      originMessage.trim().length > 0 ||
      consolidationPromptPreset.trim().length > 0 ||
      selected.some((s) => s.subtask.trim().length > 0);
    if (hasAnyInput && id !== "blank") {
      const ok = await confirm({
        title: "切换协作模板？",
        description: `切换到「${tpl.name}」模板会覆盖当前的标题、原始描述、子任务和汇总指令。`,
        confirmText: "切换",
      });
      if (!ok) return;
    }

    const vars = {
      creatorName: user?.name || user?.email || undefined,
      orgName: selfCand?.orgName || undefined,
      groupName: selfCand?.groupName || undefined,
    };
    const renderedTitle = renderVars(tpl.title, vars);
    const renderedOrigin = renderVars(tpl.originMessage, vars);
    const renderedMemberPrompt = renderVars(tpl.memberPrompt, vars);
    const renderedConsolidation = renderVars(tpl.consolidationPrompt, vars);

    setTemplateId(id);
    setTitle(renderedTitle);
    setOriginMessage(renderedOrigin);
    setConsolidationPromptPreset(renderedConsolidation);
    setSelected((prev) => prev.map((s) => ({ ...s, subtask: renderedMemberPrompt || renderedOrigin })));
    setPrevOrigin(renderedOrigin);
  };

  // 白名单拦截（嵌入 / 独立 都走这个；无 wrapper 高度，适配两种场景）
  if (wlQ.isLoading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (!wlQ.data?.whitelisted) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="text-xl font-semibold text-foreground mb-2">未开通组织协作</div>
        <div className="text-sm text-muted-foreground mb-6">{wlQ.data?.message || "请联系管理员在组织协作后台启用权限并分配协作空间"}</div>
        {onCancel ? (
          <Button variant="outline" className="lingxia-soft-action coop-back-button" onClick={onCancel}><ArrowLeft className="w-4 h-4 mr-1" /> 返回</Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {dialog}
      {/* 1. 协作描述 */}
      <Card className="p-5 bg-card border-border/50">
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-foreground mb-1 block flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-primary" /> 场景模板
            </Label>
            <div className="flex flex-wrap gap-2">
              {COOP_TEMPLATES.map((t) => {
                const active = templateId === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => applyTemplate(t.id)}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-card text-foreground border-border hover:border-primary/60"
                    }`}
                    title={t.description}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
            {templateId !== "blank" ? (
              <div className="text-[11px] text-muted-foreground mt-1.5">
                💡 {getTemplateById(templateId)?.description}。切模板会整块覆盖下方内容。
              </div>
            ) : null}
          </div>
          <div>
            <Label className="text-xs text-foreground mb-1 block">协作标题</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：Q1 合规报告" className="text-sm" />
          </div>
          <div>
            <Label className="text-xs text-foreground mb-1 block">原始任务描述</Label>
            <Textarea
              value={originMessage}
              onChange={(e) => setOriginMessage(e.target.value)}
              placeholder="详细说明要协作完成的事情，未被手动修改的子任务会跟随这里更新"
              className="min-h-[80px] text-sm"
            />
          </div>
          <div>
            <Label className="text-xs text-foreground mb-1 block">
              汇总指令（可选 · 发起时预设，汇总阶段仍可改）
            </Label>
            <Textarea
              value={consolidationPromptPreset}
              onChange={(e) => setConsolidationPromptPreset(e.target.value)}
              placeholder="例如：按人员分组列出 / 篇末追加下周重点 / 严禁套话必须带数字..."
              className="min-h-[60px] text-sm"
              maxLength={1000}
            />
            <div className="text-[10px] text-muted-foreground mt-0.5 text-right">
              {consolidationPromptPreset.length}/1000
            </div>
          </div>
        </div>
      </Card>

      {/* 2. 选人 */}
      <Card className="p-5 bg-card border-border/50">
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-semibold text-foreground">选择协作成员</div>
          <div className="text-xs text-muted-foreground">已选 {selected.length} 人</div>
        </div>
        <div className="text-[11px] text-muted-foreground mb-3">
          💡 发起人（你）默认只负责最终整合。若<strong className="text-foreground">也想让自己的 agent 干一部分活</strong>，在候选列表里选中「你（我）」即可。
        </div>

        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索姓名/部门..." className="pl-8 text-sm h-8" />
          </div>
        </div>

        {/* group 筛选 */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          <button onClick={() => setGroupFilter(undefined)} className={`text-[11px] px-2 py-0.5 rounded-full border ${groupFilter === undefined ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}>全部</button>
          {groups.map((g) => (
            <button key={g.id} onClick={() => setGroupFilter(g.id)} className={`text-[11px] px-2 py-0.5 rounded-full border ${groupFilter === g.id ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}>
              {g.name}
            </button>
          ))}
        </div>

        {/* 候选人列表 */}
        <div className="max-h-[240px] overflow-auto border border-border/40 rounded">
          {candLoading ? (
            <div className="p-4 text-center text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin inline mr-1" /> 加载中</div>
          ) : candidates.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">{(rawCandidates || []).length === 0 ? "没有候选人（需要后台设为 active 且在同一协作空间）" : "已全部选完 / 筛选无结果"}</div>
          ) : (
            candidates.map((c: Candidate) => (
              <button key={c.userId} onClick={() => pickCandidate(c)} className="w-full flex items-center gap-3 px-3 py-2 hover:bg-primary/5 border-b border-border/30 last:border-b-0 text-left">
                <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center text-xs font-medium text-primary shrink-0">
                  {(c.userName || "?").slice(0, 1)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
                    {c.userName || "(未命名)"}
                    {c.userId === selfUserId ? <span className="text-[10px] px-1.5 py-0 rounded-full bg-primary/15 text-primary font-normal">我 · 发起人</span> : null}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {formatCandidateOrg(c)}
                    {!c.departmentName && !c.teamName && c.groupName ? <><span className="mx-1">·</span><span className="text-primary">{c.groupName}</span></> : null}
                    {c.adoptId ? <><span className="mx-1">·</span>🟢 Agent: {c.adoptId.slice(0, 12)}</> : <><span className="mx-1">·</span>⚪ 无智能体</>}
                  </div>
                </div>
                <UserPlus className="w-4 h-4 text-primary shrink-0" />
              </button>
            ))
          )}
        </div>
      </Card>

      {/* 3. 每人子任务（可编辑） */}
      {selected.length > 0 ? (
        <Card className="p-5 bg-card border-border/50">
          <div className="text-sm font-semibold text-foreground mb-3">给每位成员的子任务（可分别调整）</div>
          <div className="space-y-3">
            {selected.map((s) => (
              <div key={s.cand.userId} className="flex gap-3">
                <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center text-xs font-medium text-primary shrink-0 mt-1">
                  {(s.cand.userName || "?").slice(0, 1)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs">
                      <span className="font-medium">{s.cand.userName}</span>
                      <span className="mx-1">·</span>
                      <span className="text-primary">{s.cand.groupName}</span>
                      {(s.cand.adoptionStatus || s.cand.adoptId) ? <span className="ml-1">🤖</span> : <span className="ml-1 text-muted-foreground">（模拟 agent）</span>}
                    </div>
                    <button onClick={() => unpickCandidate(s.cand.userId)} className="text-muted-foreground hover:text-destructive">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <Textarea
                    value={s.subtask}
                    onChange={(e) => updateSubtask(s.cand.userId, e.target.value)}
                    className="text-xs min-h-[60px]"
                    placeholder="分配给该成员的具体子任务"
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* 4. 提交 */}
      <div className="flex justify-end gap-2 pb-4">
        {onCancel ? (
          <Button variant="ghost" className="lingxia-soft-action" onClick={onCancel}>取消</Button>
        ) : null}
        <Button
          onClick={handleSubmit}
          disabled={!canSubmit || createMut.isPending}
          className="coop-submit-button"
        >
          {createMut.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
          <Sparkles className="w-3 h-3 mr-1" /> 发起协作
        </Button>
      </div>
    </div>
  );
}

// 独立路由 /coop/new 的薄壳：sticky header + 默认 navigation
export default function CoopNew() {
  const [, setLocation] = useLocation();
  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else setLocation("/");
  };
  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border/50">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
          <Button variant="ghost" size="sm" className="lingxia-soft-action coop-back-button" onClick={goBack}>
            <ArrowLeft className="w-4 h-4 mr-1" /> 返回
          </Button>
          <div className="flex-1 flex items-center gap-2">
            <UsersIcon className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-semibold text-foreground">发起多人协作</h1>
            <span className="text-xs text-muted-foreground">·  多智能体并行 · 自动汇总</span>
          </div>
        </div>
      </div>
      <div className="px-6 py-6">
        <CoopNewForm
          onDone={(sid) => setLocation(`/coop/${sid}`)}
          onCancel={goBack}
        />
      </div>
    </div>
  );
}
