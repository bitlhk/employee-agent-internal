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
import { AlertTriangle, Archive, Check, Clock3, FileInput, FolderOpen, Loader2, PackageCheck, Plus, RefreshCw, ShieldCheck, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";

type Overview = RouterOutputs["enterpriseAssets"]["overview"];
type Candidate = Overview["candidates"][number];

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿", review_pending: "待审核", approved: "审核通过", rejected: "已退回", published: "已发布", stale: "已失效",
};
const RELEASE_STATUS_LABELS: Record<string, string> = {
  ready_to_stage: "可进入岗位验证",
  awaiting_validation: "待标杆任务验收",
  validated_pending_effective: "已验证，等待生效",
  active: "当前有效",
  expired: "已失效",
  inactive: "未启用",
};
const TYPE_LABELS: Record<string, string> = {
  knowledge_document: "知识文档", business_data: "业务数据", policy: "确定性策略", skill: "Skill", mcp_capability: "MCP 能力", role_identity: "岗位身份",
};
const TARGET_BY_TYPE: Record<string, "knowledge_document" | "enterprise_mcp" | "skill" | "policy" | "role"> = {
  knowledge_document: "knowledge_document", business_data: "enterprise_mcp", policy: "policy", skill: "skill", mcp_capability: "enterprise_mcp", role_identity: "role",
};

const EMPTY_SOURCE = {
  sourceId: "", displayName: "", sourceType: "document_repository" as const, sourceUri: "",
  ownerDepartment: "", ownerContact: "", syncMode: "manual" as const, status: "active" as const,
};

type DiscoveryMode = "files" | "zip" | "object_inventory";

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function candidateDiagnostics(candidate: Candidate): Array<Record<string, unknown>> {
  if (!Array.isArray(candidate.diagnosticsJson)) return [];
  return candidate.diagnosticsJson.filter(item => item && typeof item === "object" && !(item as Record<string, unknown>).resolvedAt) as Array<Record<string, unknown>>;
}

export function EnterpriseAssetsPanel() {
  const utils = trpc.useUtils();
  const { data, isLoading, refetch } = trpc.enterpriseAssets.overview.useQuery({});
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState({ ...EMPTY_SOURCE });
  const [importOpen, setImportOpen] = useState(false);
  const [importSourceId, setImportSourceId] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoverySourceId, setDiscoverySourceId] = useState("");
  const [discoveryMode, setDiscoveryMode] = useState<DiscoveryMode>("files");
  const [discoveryFiles, setDiscoveryFiles] = useState<File[]>([]);
  const [inventoryText, setInventoryText] = useState("");
  const [useModelSuggestion, setUseModelSuggestion] = useState(false);
  const [allowContentProcessing, setAllowContentProcessing] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<Candidate | null>(null);
  const [metadataText, setMetadataText] = useState("");
  const [rejectTarget, setRejectTarget] = useState<Candidate | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [publishTarget, setPublishTarget] = useState<Candidate | null>(null);
  const [targetAssetId, setTargetAssetId] = useState("");
  const [stageTarget, setStageTarget] = useState<Candidate | null>(null);
  const [targetKnowledgeBaseId, setTargetKnowledgeBaseId] = useState("");

  const invalidate = async () => utils.enterpriseAssets.overview.invalidate();
  const saveSource = trpc.enterpriseAssets.saveSource.useMutation({
    onSuccess: async () => { toast.success("接入来源已保存"); setSourceOpen(false); setSource({ ...EMPTY_SOURCE }); await invalidate(); },
    onError: error => toast.error(error.message),
  });
  const importManifest = trpc.enterpriseAssets.importManifest.useMutation({
    onSuccess: async result => { toast.success(`已导入 ${result.imported} 个候选资产`); setImportOpen(false); setManifestText(""); await invalidate(); },
    onError: error => toast.error(error.message),
  });
  const discoverArtifacts = trpc.enterpriseAssets.discoverArtifacts.useMutation({
    onSuccess: async result => {
      toast.success(`已发现 ${result.discovered} 个资产，${result.remediationCount} 个需要确认`);
      setDiscoveryOpen(false);
      setDiscoveryFiles([]);
      setInventoryText("");
      setUseModelSuggestion(false);
      setAllowContentProcessing(false);
      await invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const submitReview = trpc.enterpriseAssets.submitReview.useMutation({
    onSuccess: async () => { toast.success("已提交审核"); setReviewTarget(null); await invalidate(); },
    onError: error => toast.error(error.message),
  });
  const review = trpc.enterpriseAssets.review.useMutation({
    onSuccess: async (_result, variables) => { toast.success(variables.decision === "approve" ? "资产已审核通过" : "资产已退回"); setRejectTarget(null); setRejectNote(""); await invalidate(); },
    onError: error => toast.error(error.message),
  });
  const publish = trpc.enterpriseAssets.publish.useMutation({
    onSuccess: async () => { toast.success("资产映射已发布，相关岗位包需重新验收"); setPublishTarget(null); setTargetAssetId(""); await invalidate(); },
    onError: error => toast.error(error.message),
  });
  const stageKnowledgeVersion = trpc.enterpriseAssets.stageKnowledgeVersion.useMutation({
    onSuccess: async () => {
      toast.success("知识版本已进入岗位验证，尚未对员工生效");
      setStageTarget(null);
      setTargetKnowledgeBaseId("");
      await invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const activateKnowledgeVersion = trpc.enterpriseAssets.activateKnowledgeVersion.useMutation({
    onSuccess: async result => {
      toast.success(result.releaseStatus === "validated_pending_effective" ? "验证完成，将按生效时间自动启用" : "知识版本已启用");
      await invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const verifyKnowledgeVersion = trpc.enterpriseAssets.verifyKnowledgeVersion.useMutation({
    onSuccess: async result => {
      toast[result.status === "PASS" ? "success" : "error"](result.status === "PASS" ? "候选版本和财富经理标杆任务已通过" : "候选版本验证未通过，请查看检查结果");
      await invalidate();
    },
    onError: error => toast.error(error.message),
  });

  const activeSources = useMemo(() => (data?.sources || []).filter(item => item.status === "active"), [data?.sources]);
  const busy = saveSource.isPending || importManifest.isPending || discoverArtifacts.isPending || submitReview.isPending
    || review.isPending || publish.isPending || stageKnowledgeVersion.isPending
    || verifyKnowledgeVersion.isPending || activateKnowledgeVersion.isPending;

  const openReview = (candidate: Candidate) => {
    const suggested = { ...((candidate.suggestedMetadataJson || {}) as Record<string, unknown>) };
    suggested.logicalAssetIds = Array.isArray(suggested.logicalAssetCandidates) ? suggested.logicalAssetCandidates : [];
    delete suggested.enterpriseId;
    delete suggested.suggestedDomain;
    delete suggested.logicalAssetCandidates;
    delete suggested.suggestionMethod;
    setMetadataText(JSON.stringify(suggested, null, 2));
    setReviewTarget(candidate);
  };

  const doImport = () => {
    try {
      importManifest.mutate({ sourceId: importSourceId, manifest: JSON.parse(manifestText) });
    } catch {
      toast.error("Manifest 不是有效 JSON");
    }
  };

  const doSubmitReview = () => {
    if (!reviewTarget) return;
    try {
      submitReview.mutate({ candidateId: reviewTarget.candidateId, confirmedMetadata: JSON.parse(metadataText) });
    } catch {
      toast.error("确认元数据不是有效 JSON");
    }
  };

  const doDiscover = async () => {
    if (!discoverySourceId) return;
    try {
      if (discoveryMode === "object_inventory") {
        const objects = JSON.parse(inventoryText);
        if (!Array.isArray(objects)) throw new Error("对象清单必须是 JSON 数组");
        discoverArtifacts.mutate({
          sourceId: discoverySourceId,
          mode: discoveryMode,
          objects,
          useModelSuggestion,
          allowContentProcessing: false,
        });
        return;
      }
      if (!discoveryFiles.length) throw new Error("请选择文件");
      if (discoveryMode === "zip") {
        const file = discoveryFiles[0];
        discoverArtifacts.mutate({
          sourceId: discoverySourceId,
          mode: discoveryMode,
          zip: { name: file.name, contentBase64: await fileBase64(file) },
          useModelSuggestion,
          allowContentProcessing,
        });
        return;
      }
      const files = await Promise.all(discoveryFiles.slice(0, 100).map(async file => ({
        name: file.name,
        relativePath: file.webkitRelativePath || file.name,
        contentBase64: await fileBase64(file),
        lastModified: new Date(file.lastModified).toISOString(),
      })));
      discoverArtifacts.mutate({
        sourceId: discoverySourceId,
        mode: discoveryMode,
        files,
        useModelSuggestion,
        allowContentProcessing,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "资产发现输入无效");
    }
  };

  if (isLoading) return <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">企业资产接入与整改</h2>
          <p className="mt-1 text-xs text-muted-foreground">发现存量资产、自动诊断治理问题；人工确认后才可进入现有 Runtime Context 链路。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />刷新</Button>
          <Button variant="outline" size="sm" onClick={() => { setImportSourceId(activeSources[0]?.sourceId || ""); setImportOpen(true); }} disabled={!activeSources.length}>
            <FileInput className="mr-1.5 h-3.5 w-3.5" />高级导入
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setDiscoverySourceId(activeSources[0]?.sourceId || ""); setDiscoveryOpen(true); }} disabled={!activeSources.length}>
            <UploadCloud className="mr-1.5 h-3.5 w-3.5" />发现资产
          </Button>
          <Button size="sm" onClick={() => setSourceOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" />登记来源</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {[
          ["接入来源", data?.summary.sources || 0], ["待整改", data?.summary.pendingRemediation || 0], ["待审核", data?.summary.pendingReview || 0], ["审核通过", data?.summary.approved || 0],
          ["已发布", data?.summary.published || 0], ["待重验", data?.summary.stale || 0],
        ].map(([label, value]) => <Card key={String(label)} className="p-3"><div className="text-xl font-semibold text-gray-900">{value}</div><div className="mt-1 text-xs text-muted-foreground">{label}</div></Card>)}
      </div>

      <Card className="overflow-hidden border-border/50 bg-white/90">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-900">资产候选与发布状态</h3>
        </div>
        <div className="divide-y">
          {(data?.candidates || []).map(candidate => {
            const impact = (candidate.impactAnalysisJson || {}) as { affectedTaskIds?: unknown };
            const diagnostics = candidateDiagnostics(candidate);
            const suggestion = (candidate.suggestedMetadataJson || {}) as { applicableRoles?: unknown; logicalAssetCandidates?: unknown; suggestionMethod?: unknown };
            return (
              <div key={candidate.candidateId} className="flex flex-col gap-3 px-4 py-4 xl:flex-row xl:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900">{candidate.displayName}</span>
                    <Badge variant="outline">{TYPE_LABELS[candidate.assetType] || candidate.assetType}</Badge>
                    <Badge variant={candidate.status === "published" ? "default" : "secondary"}>{STATUS_LABELS[candidate.status] || candidate.status}</Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{candidate.enterpriseAssetId} · v{candidate.sourceVersion} · {candidate.sourceId}</div>
                  {Array.isArray(suggestion.applicableRoles) && suggestion.applicableRoles.length > 0 && <div className="mt-1 text-xs text-muted-foreground">建议岗位：{suggestion.applicableRoles.map(String).join("、")}</div>}
                  {Array.isArray(suggestion.logicalAssetCandidates) && suggestion.logicalAssetCandidates.length > 0 && <div className="mt-1 text-xs text-muted-foreground">逻辑资产候选：{suggestion.logicalAssetCandidates.map(String).join("、")}</div>}
                  {candidate.targetAssetId && <div className="mt-1 text-xs text-emerald-700">Runtime 映射：{candidate.targetAssetType} / {candidate.targetAssetId}</div>}
                  {candidate.assetType === "knowledge_document" && RELEASE_STATUS_LABELS[candidate.releaseStatus] && <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock3 className="h-3 w-3" />{RELEASE_STATUS_LABELS[candidate.releaseStatus]}
                    {candidate.runtimeDocument?.effectiveAt && candidate.releaseStatus === "validated_pending_effective" ? ` · ${new Date(candidate.runtimeDocument.effectiveAt).toLocaleString("zh-CN")} 生效` : ""}
                  </div>}
                  {candidate.validationStatus && <div className={`mt-1 text-xs ${candidate.validationStatus === "PASS" ? "text-emerald-700" : "text-red-600"}`}>候选级标杆任务：{candidate.validationStatus === "PASS" ? "已通过" : "未通过"}</div>}
                  {Array.isArray(impact.affectedTaskIds) && impact.affectedTaskIds.length > 0 && <div className="mt-1 text-xs text-amber-700">需重跑：{impact.affectedTaskIds.join("、")}</div>}
                  {diagnostics.length > 0 && <div className="mt-2 space-y-1 rounded border border-amber-200 bg-amber-50 px-2.5 py-2">
                    {diagnostics.slice(0, 3).map((diagnostic, index) => <div key={`${String(diagnostic.code)}-${index}`} className="flex items-start gap-1.5 text-xs text-amber-800"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /><span>{String(diagnostic.message || diagnostic.code || "需要人工确认")}</span></div>)}
                    {diagnostics.length > 3 && <div className="text-xs text-amber-700">另有 {diagnostics.length - 3} 项待确认</div>}
                  </div>}
                  {candidate.reviewNote && <div className="mt-1 text-xs text-red-600">评审意见：{candidate.reviewNote}</div>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {(["draft", "rejected"] as string[]).includes(candidate.status) && <Button variant="outline" size="sm" onClick={() => openReview(candidate)}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />提交审核</Button>}
                  {candidate.status === "review_pending" && <>
                    <Button size="sm" onClick={() => review.mutate({ candidateId: candidate.candidateId, decision: "approve" })}><Check className="mr-1.5 h-3.5 w-3.5" />通过</Button>
                    <Button variant="outline" size="sm" onClick={() => setRejectTarget(candidate)}><X className="mr-1.5 h-3.5 w-3.5" />退回</Button>
                  </>}
                  {candidate.status === "approved" && candidate.assetType === "knowledge_document" && !candidate.targetAssetId && <Button size="sm" onClick={() => {
                    setStageTarget(candidate);
                    const role = Array.isArray((candidate.confirmedMetadataJson as { applicableRoles?: unknown } | null)?.applicableRoles)
                      ? String((candidate.confirmedMetadataJson as { applicableRoles: unknown[] }).applicableRoles[0] || "") : "";
                    setTargetKnowledgeBaseId(data?.knowledgeBases.find(base => base.roleTemplate === role)?.publicId || data?.knowledgeBases[0]?.publicId || "");
                  }}><PackageCheck className="mr-1.5 h-3.5 w-3.5" />进入岗位验证</Button>}
                  {candidate.status === "approved" && candidate.assetType === "knowledge_document" && candidate.targetAssetId && candidate.validationStatus !== "PASS" && <Button variant="outline" size="sm" disabled={busy} onClick={() => verifyKnowledgeVersion.mutate({ candidateId: candidate.candidateId })}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />运行标杆任务</Button>}
                  {candidate.status === "approved" && candidate.assetType === "knowledge_document" && candidate.targetAssetId && candidate.validationStatus === "PASS" && <Button size="sm" disabled={busy} onClick={() => activateKnowledgeVersion.mutate({ candidateId: candidate.candidateId })}><Check className="mr-1.5 h-3.5 w-3.5" />按生效时间启用</Button>}
                  {candidate.status === "approved" && candidate.assetType !== "knowledge_document" && <Button size="sm" onClick={() => { setPublishTarget(candidate); setTargetAssetId(""); }}><PackageCheck className="mr-1.5 h-3.5 w-3.5" />发布映射</Button>}
                </div>
              </div>
            );
          })}
          {!data?.candidates.length && <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无候选资产</div>}
        </div>
      </Card>

      <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>登记企业资产来源</DialogTitle><DialogDescription>登记权威来源和责任部门，正文或凭据不保存在这里。</DialogDescription></DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>来源 ID</Label><Input value={source.sourceId} onChange={e => setSource({ ...source, sourceId: e.target.value })} placeholder="bank-wealth-policy" /></div>
            <div><Label>名称</Label><Input value={source.displayName} onChange={e => setSource({ ...source, displayName: e.target.value })} /></div>
            <div><Label>来源类型</Label><Select value={source.sourceType} onValueChange={value => setSource({ ...source, sourceType: value as any })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[
              ["document_repository", "制度/文档库"], ["business_system", "业务系统"], ["rule_catalog", "规则目录"], ["workflow_catalog", "流程目录"], ["capability_service", "能力服务"], ["identity_directory", "IAM/组织目录"],
            ].map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>责任部门</Label><Input value={source.ownerDepartment} onChange={e => setSource({ ...source, ownerDepartment: e.target.value })} /></div>
            <div className="sm:col-span-2"><Label>来源地址</Label><Input value={source.sourceUri} onChange={e => setSource({ ...source, sourceUri: e.target.value })} placeholder="https://... 或内部来源标识" /></div>
            <div className="sm:col-span-2"><Label>责任人/联系方式</Label><Input value={source.ownerContact} onChange={e => setSource({ ...source, ownerContact: e.target.value })} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setSourceOpen(false)}>取消</Button><Button disabled={busy} onClick={() => saveSource.mutate({ ...source, sourceUri: source.sourceUri || null, ownerContact: source.ownerContact || null })}>保存</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>发现企业资产</DialogTitle>
            <DialogDescription>扫描结果只生成候选资产。系统会建议元数据并标记治理问题，不会自动审核或发布。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>接入来源</Label>
              <Select value={discoverySourceId} onValueChange={setDiscoverySourceId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{activeSources.map(item => <SelectItem key={item.sourceId} value={item.sourceId}>{item.displayName}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>发现方式</Label>
              <div className="mt-1.5 grid grid-cols-3 gap-2">
                {([
                  ["files", "文件 / 文件夹", FolderOpen],
                  ["zip", "ZIP 压缩包", Archive],
                  ["object_inventory", "对象存储清单", FileInput],
                ] as const).map(([mode, label, Icon]) => <Button key={mode} type="button" size="sm" variant={discoveryMode === mode ? "default" : "outline"} onClick={() => { setDiscoveryMode(mode); setDiscoveryFiles([]); }}><Icon className="mr-1.5 h-3.5 w-3.5" />{label}</Button>)}
              </div>
            </div>

            {discoveryMode === "files" && <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded border border-dashed px-3 py-5 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground">
                <UploadCloud className="h-4 w-4" />选择文件
                <input className="hidden" type="file" multiple accept=".md,.txt,.csv,.json,.yaml,.yml,.pdf,.docx,.xlsx,.pptx" onChange={event => setDiscoveryFiles(Array.from(event.currentTarget.files || []))} />
              </label>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded border border-dashed px-3 py-5 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground">
                <FolderOpen className="h-4 w-4" />选择文件夹
                <input className="hidden" type="file" multiple accept=".md,.txt,.csv,.json,.yaml,.yml,.pdf,.docx,.xlsx,.pptx" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={event => setDiscoveryFiles(Array.from(event.currentTarget.files || []))} />
              </label>
            </div>}

            {discoveryMode === "zip" && <label className="flex cursor-pointer items-center justify-center gap-2 rounded border border-dashed px-3 py-6 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground">
              <Archive className="h-4 w-4" />选择 ZIP 压缩包
              <input className="hidden" type="file" accept=".zip,application/zip" onChange={event => setDiscoveryFiles(Array.from(event.currentTarget.files || []).slice(0, 1))} />
            </label>}

            {discoveryMode === "object_inventory" && <div>
              <Label>对象清单 JSON</Label>
              <Textarea className="mt-1.5 min-h-48 font-mono text-xs" value={inventoryText} onChange={event => setInventoryText(event.target.value)} placeholder={'[{\n  "key": "wealth/policy-v3.2.pdf",\n  "checksum": "64位SHA256",\n  "sizeBytes": 1024,\n  "sourceUri": "obs://bucket/wealth/policy-v3.2.pdf",\n  "lastModified": "2026-08-20T08:00:00.000Z"\n}]'} />
              <p className="mt-1 text-xs text-muted-foreground">V1 接收对象存储导出的受信目录清单，不保存云凭据，也不主动拉取正文。</p>
            </div>}

            {discoveryMode !== "object_inventory" && discoveryFiles.length > 0 && <div className="text-xs text-muted-foreground">已选择 {discoveryFiles.length} 个文件，共 {(discoveryFiles.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} MB</div>}

            <div className="space-y-2 rounded border bg-muted/30 px-3 py-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={useModelSuggestion} onChange={event => { setUseModelSuggestion(event.target.checked); if (!event.target.checked) setAllowContentProcessing(false); }} />使用平台模型增强元数据建议</label>
              <label className={`flex items-center gap-2 text-sm ${useModelSuggestion ? "" : "text-muted-foreground"}`}><input type="checkbox" disabled={!useModelSuggestion} checked={allowContentProcessing} onChange={event => setAllowContentProcessing(event.target.checked)} />允许向平台模型发送文本文件的有限摘要</label>
              <p className="text-xs text-muted-foreground">模型只提供建议；权限、密级、生命周期和发布状态仍由确定性规则与人工审核决定。</p>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setDiscoveryOpen(false)}>取消</Button><Button disabled={busy || !discoverySourceId || (discoveryMode === "object_inventory" ? !inventoryText.trim() : !discoveryFiles.length)} onClick={doDiscover}>{discoverArtifacts.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}开始发现</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>高级导入 Manifest</DialogTitle><DialogDescription>用于已有治理系统对接。日常文件接入请使用“发现资产”；仅接收 `linggan.enterprise-asset/v1`。</DialogDescription></DialogHeader>
          <div><Label>接入来源</Label><Select value={importSourceId} onValueChange={setImportSourceId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{activeSources.map(item => <SelectItem key={item.sourceId} value={item.sourceId}>{item.displayName}</SelectItem>)}</SelectContent></Select></div>
          <div><Label>Manifest JSON</Label><Textarea className="min-h-72 font-mono text-xs" value={manifestText} onChange={e => setManifestText(e.target.value)} /></div>
          <DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button><Button disabled={busy || !importSourceId || !manifestText.trim()} onClick={doImport}>导入候选</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(reviewTarget)} onOpenChange={open => !open && setReviewTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>确认治理元数据</DialogTitle><DialogDescription>{reviewTarget?.displayName}。提交后进入独立审核，不会直接发布。</DialogDescription></DialogHeader>
          <Textarea className="min-h-80 font-mono text-xs" value={metadataText} onChange={e => setMetadataText(e.target.value)} />
          <DialogFooter><Button variant="outline" onClick={() => setReviewTarget(null)}>取消</Button><Button disabled={busy} onClick={doSubmitReview}>提交审核</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(rejectTarget)} onOpenChange={open => !open && setRejectTarget(null)}>
        <DialogContent><DialogHeader><DialogTitle>退回候选资产</DialogTitle><DialogDescription>说明需补充或修正的元数据。</DialogDescription></DialogHeader><Textarea value={rejectNote} onChange={e => setRejectNote(e.target.value)} /><DialogFooter><Button variant="outline" onClick={() => setRejectTarget(null)}>取消</Button><Button disabled={busy || !rejectNote.trim()} onClick={() => rejectTarget && review.mutate({ candidateId: rejectTarget.candidateId, decision: "reject", note: rejectNote })}>确认退回</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={Boolean(publishTarget)} onOpenChange={open => !open && setPublishTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>发布 Runtime 映射</DialogTitle><DialogDescription>必须绑定到已存在的 {publishTarget ? TARGET_BY_TYPE[publishTarget.assetType] : "Runtime 资产"}。发布会使受影响岗位包进入待重验状态。</DialogDescription></DialogHeader>
          <div><Label>目标资产 ID</Label><Input value={targetAssetId} onChange={e => setTargetAssetId(e.target.value)} placeholder="现有知识 publicId、MCP serverId、Skill ID 或岗位 ID" /></div>
          <DialogFooter><Button variant="outline" onClick={() => setPublishTarget(null)}>取消</Button><Button disabled={busy || !targetAssetId.trim()} onClick={() => publishTarget && publish.mutate({ candidateId: publishTarget.candidateId, targetAssetType: TARGET_BY_TYPE[publishTarget.assetType], targetAssetId: targetAssetId.trim() })}>确认发布</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(stageTarget)} onOpenChange={open => !open && setStageTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>进入岗位验证</DialogTitle><DialogDescription>知识版本将以草稿进入现有知识库并触发受影响岗位重验；通过标杆任务前不会提供给员工。</DialogDescription></DialogHeader>
          <div><Label>目标知识库</Label><Select value={targetKnowledgeBaseId} onValueChange={setTargetKnowledgeBaseId}><SelectTrigger><SelectValue placeholder="选择岗位或企业知识库" /></SelectTrigger><SelectContent>{(data?.knowledgeBases || []).map(base => <SelectItem key={base.publicId} value={base.publicId}>{base.name}{base.roleTemplate ? ` · ${base.roleTemplate}` : ""}</SelectItem>)}</SelectContent></Select></div>
          <DialogFooter><Button variant="outline" onClick={() => setStageTarget(null)}>取消</Button><Button disabled={busy || !targetKnowledgeBaseId} onClick={() => stageTarget && stageKnowledgeVersion.mutate({ candidateId: stageTarget.candidateId, knowledgeBaseId: targetKnowledgeBaseId })}>确认进入验证</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
