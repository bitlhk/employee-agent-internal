import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ASSET_ISSUE_GROUPS, assetMatchesIssue, countAssetIssues, fromLocalDateTimeInput, normalizedReviewMetadata,
  stringList, suggestionSourceEvidence, suggestionSourceLabel, toLocalDateTimeInput, unresolvedAssetDiagnostics,
  type AssetIssueGroup,
} from "@/lib/enterprise-asset-experience";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, Archive, Check, Clock3, FileInput, FolderOpen, ListFilter, Loader2, PackageCheck, Plus, RefreshCw, ShieldCheck, Sparkles, UploadCloud, UserCheck, X } from "lucide-react";
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
const SOURCE_RUN_LABELS: Record<string, string> = {
  running: "同步中", succeeded: "成功", partial: "部分完成", failed: "失败",
};

const EMPTY_SOURCE = {
  sourceId: "", displayName: "", sourceType: "document_repository" as const, sourceUri: "",
  ownerDepartment: "", ownerContact: "", syncMode: "manual" as const, status: "active" as const,
};

const EMPTY_OBJECT_STORAGE = {
  scheme: "obs" as "obs" | "s3",
  endpoint: "",
  bucket: "",
  prefix: "",
  region: "cn-east-3",
  credentialRef: "env://GRACE_OBS",
  forcePathStyle: true,
};

function objectStorageSourceUri(input: typeof EMPTY_OBJECT_STORAGE): string {
  const query = new URLSearchParams({
    ...(input.endpoint.trim() ? { endpoint: input.endpoint.trim().replace(/\/$/, "") } : {}),
    region: input.region.trim() || "us-east-1",
    credentialRef: input.credentialRef.trim(),
    forcePathStyle: String(input.forcePathStyle),
  });
  const prefix = input.prefix.trim().replace(/^\/+/, "");
  return `${input.scheme}://${input.bucket.trim()}/${prefix}?${query}`;
}

type DiscoveryMode = "files" | "zip" | "object_inventory";

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function candidateDiagnostics(candidate: Candidate | null | undefined): Array<Record<string, unknown>> {
  if (!candidate) return [];
  return unresolvedAssetDiagnostics(candidate.diagnosticsJson) as Array<Record<string, unknown>>;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function FieldProvenance({ candidate, field, extracted = false }: { candidate: Candidate | null; field: string; extracted?: boolean }) {
  if (!candidate) return null;
  const confirmed = recordOf(candidate.confirmedMetadataJson);
  const suggested = recordOf(candidate.suggestedMetadataJson);
  const diagnostic = candidateDiagnostics(candidate).find(item => item.field === field);
  if (Object.prototype.hasOwnProperty.call(confirmed, field)) {
    return <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-700"><UserCheck className="h-3 w-3" />人工确认{candidate.reviewedBy ? ` · ${candidate.reviewedBy}` : ""}{candidate.reviewedAt ? ` · ${new Date(candidate.reviewedAt).toLocaleString("zh-CN")}` : ""}</div>;
  }
  if (extracted) return <div className="mt-1 text-[11px] text-muted-foreground">系统提取 · 依据文件名与接入路径</div>;
  return <div className="mt-1 text-[11px] text-muted-foreground">{suggestionSourceLabel(suggested.suggestionMethod)} · {diagnostic ? String(diagnostic.message || "待人工确认") : suggestionSourceEvidence(suggested.suggestionMethod)}</div>;
}

export function EnterpriseAssetsPanel() {
  const utils = trpc.useUtils();
  const { data, isLoading, refetch } = trpc.enterpriseAssets.overview.useQuery({});
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState({ ...EMPTY_SOURCE });
  const [sourceConnectionMode, setSourceConnectionMode] = useState<"address" | "filesystem" | "object_storage">("address");
  const [objectStorage, setObjectStorage] = useState({ ...EMPTY_OBJECT_STORAGE });
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
  const [filesystemSyncOpen, setFilesystemSyncOpen] = useState(false);
  const [filesystemSyncSourceId, setFilesystemSyncSourceId] = useState("");
  const [operationsSourceId, setOperationsSourceId] = useState("");
  const [filesystemUseModelSuggestion, setFilesystemUseModelSuggestion] = useState(false);
  const [filesystemAllowContentProcessing, setFilesystemAllowContentProcessing] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<Candidate | null>(null);
  const [reviewDisplayName, setReviewDisplayName] = useState("");
  const [reviewSourceVersion, setReviewSourceVersion] = useState("");
  const [reviewMetadata, setReviewMetadata] = useState<Record<string, unknown>>({});
  const [metadataText, setMetadataText] = useState("");
  const [advancedMetadata, setAdvancedMetadata] = useState(false);
  const [assetListMode, setAssetListMode] = useState<"remediation" | "all">("remediation");
  const [issueFilter, setIssueFilter] = useState<AssetIssueGroup>("all");
  const [rejectTarget, setRejectTarget] = useState<Candidate | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [publishTarget, setPublishTarget] = useState<Candidate | null>(null);
  const [targetAssetId, setTargetAssetId] = useState("");
  const [stageTarget, setStageTarget] = useState<Candidate | null>(null);
  const [targetKnowledgeBaseId, setTargetKnowledgeBaseId] = useState("");

  const activeSources = useMemo(() => (data?.sources || []).filter(item => item.status === "active"), [data?.sources]);
  const operationsSources = useMemo(() => activeSources.filter(item => ["document_repository", "rule_catalog"].includes(item.sourceType)), [activeSources]);
  const filesystemSources = useMemo(() => activeSources.filter(item => (
    item.sourceType === "document_repository" && String(item.sourceUri || "").startsWith("file://")
  )), [activeSources]);
  const resolvedOperationsSourceId = operationsSourceId || operationsSources[0]?.sourceId || "";
  const sourceSyncStatus = trpc.enterpriseAssets.sourceSyncStatus.useQuery(
    { sourceId: resolvedOperationsSourceId || "disabled" },
    { enabled: Boolean(resolvedOperationsSourceId) },
  );

  useEffect(() => {
    if (!operationsSourceId && operationsSources[0]?.sourceId) setOperationsSourceId(operationsSources[0].sourceId);
  }, [operationsSourceId, operationsSources]);

  const invalidate = async () => {
    await Promise.all([
      utils.enterpriseAssets.overview.invalidate(),
      utils.enterpriseAssets.sourceSyncStatus.invalidate(),
    ]);
  };
  const saveSource = trpc.enterpriseAssets.saveSource.useMutation({
    onSuccess: async () => {
      toast.success("接入来源已保存");
      setSourceOpen(false);
      setSource({ ...EMPTY_SOURCE });
      setSourceConnectionMode("address");
      setObjectStorage({ ...EMPTY_OBJECT_STORAGE });
      await invalidate();
    },
    onError: async error => { toast.error(error.message); await invalidate(); },
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
  const syncFilesystemSource = trpc.enterpriseAssets.syncFilesystemSource.useMutation({
    onSuccess: async result => {
      toast.success(`同步完成：新增 ${result.created}，变化 ${result.changed}，未变化 ${result.unchanged}，删除候选 ${result.tombstones}`);
      setFilesystemSyncOpen(false);
      setFilesystemUseModelSuggestion(false);
      setFilesystemAllowContentProcessing(false);
      await invalidate();
    },
    onError: async error => { toast.error(error.message); await invalidate(); },
  });
  const syncObjectStorageSource = trpc.enterpriseAssets.syncObjectStorageSource.useMutation({
    onSuccess: async result => {
      toast.success(`同步完成：新增 ${result.created}，变化 ${result.changed}，未变化 ${result.unchanged}，删除候选 ${result.tombstones}`);
      await invalidate();
    },
    onError: async error => { toast.error(error.message); await invalidate(); },
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

  const remediationCandidates = useMemo(() => (data?.candidates || []).filter(candidate => ["draft", "rejected"].includes(candidate.status) && candidateDiagnostics(candidate).length > 0), [data?.candidates]);
  const issueCounts = useMemo(() => countAssetIssues(remediationCandidates), [remediationCandidates]);
  const visibleCandidates = useMemo(() => assetListMode === "all"
    ? (data?.candidates || [])
    : remediationCandidates.filter(candidate => assetMatchesIssue(candidate.diagnosticsJson, issueFilter)), [assetListMode, data?.candidates, issueFilter, remediationCandidates]);
  const busy = saveSource.isPending || importManifest.isPending || discoverArtifacts.isPending || syncFilesystemSource.isPending || syncObjectStorageSource.isPending || submitReview.isPending
    || review.isPending || publish.isPending || stageKnowledgeVersion.isPending
    || verifyKnowledgeVersion.isPending || activateKnowledgeVersion.isPending;
  const latestSourceRun = sourceSyncStatus.data?.runs[0];
  const operationsSource = operationsSources.find(item => item.sourceId === resolvedOperationsSourceId);
  const sourceRunError = latestSourceRun?.errorJson && typeof latestSourceRun.errorJson === "object"
    ? String((latestSourceRun.errorJson as Record<string, unknown>).message || "同步未完成")
    : "";
  const operationsSourceUri = String(operationsSource?.sourceUri || "");
  const operationsConnector = operationsSourceUri.startsWith("file://")
    ? "filesystem"
    : /^(?:s3|obs):\/\//.test(operationsSourceUri) ? "object_storage" : null;

  const syncOperationsSource = (resumeOfRunId?: string) => {
    if (!operationsSource || !operationsConnector) return;
    const payload = {
      sourceId: operationsSource.sourceId,
      ...(resumeOfRunId ? { resumeOfRunId } : {}),
      useModelSuggestion: false,
      allowContentProcessing: false,
    };
    if (operationsConnector === "filesystem") syncFilesystemSource.mutate(payload);
    else syncObjectStorageSource.mutate(payload);
  };

  const saveRegisteredSource = () => {
    const sourceUri = source.sourceType === "document_repository" && sourceConnectionMode === "object_storage"
      ? objectStorageSourceUri(objectStorage)
      : source.sourceUri || null;
    saveSource.mutate({ ...source, sourceUri, ownerContact: source.ownerContact || null });
  };

  const openReview = (candidate: Candidate) => {
    const metadata = normalizedReviewMetadata(candidate.confirmedMetadataJson || candidate.suggestedMetadataJson);
    setReviewDisplayName(candidate.displayName);
    setReviewSourceVersion(candidate.sourceVersion);
    setReviewMetadata(metadata);
    setMetadataText(JSON.stringify(metadata, null, 2));
    setAdvancedMetadata(false);
    setReviewTarget(candidate);
  };

  const updateMetadata = (field: string, value: unknown) => setReviewMetadata(current => ({ ...current, [field]: value }));

  const toggleAdvancedMetadata = () => {
    if (!advancedMetadata) {
      setMetadataText(JSON.stringify(reviewMetadata, null, 2));
      setAdvancedMetadata(true);
      return;
    }
    try {
      setReviewMetadata(normalizedReviewMetadata(JSON.parse(metadataText)));
      setAdvancedMetadata(false);
    } catch {
      toast.error("高级元数据不是有效 JSON");
    }
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
      const confirmedMetadata = normalizedReviewMetadata(advancedMetadata ? JSON.parse(metadataText) : reviewMetadata);
      submitReview.mutate({ candidateId: reviewTarget.candidateId, displayName: reviewDisplayName.trim(), sourceVersion: reviewSourceVersion.trim(), confirmedMetadata: confirmedMetadata as any });
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
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />刷新</Button>
          <Button variant="outline" size="sm" onClick={() => { setImportSourceId(activeSources[0]?.sourceId || ""); setImportOpen(true); }} disabled={!activeSources.length}>
            <FileInput className="mr-1.5 h-3.5 w-3.5" />高级导入
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setDiscoverySourceId(activeSources[0]?.sourceId || ""); setDiscoveryOpen(true); }} disabled={!activeSources.length}>
            <UploadCloud className="mr-1.5 h-3.5 w-3.5" />发现资产
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setFilesystemSyncSourceId(filesystemSources[0]?.sourceId || ""); setFilesystemSyncOpen(true); }} disabled={!filesystemSources.length}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />同步挂载目录
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

      {operationsSources.length > 0 && <Card data-testid="source-operations" className="overflow-hidden border-border/50 bg-white/90">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">来源同步状态</h3>
            <p className="mt-1 text-xs text-muted-foreground">查看外部来源最近一次同步事实；来源正常不代表岗位 Context 已就绪。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={resolvedOperationsSourceId} onValueChange={setOperationsSourceId}>
              <SelectTrigger aria-label="选择来源同步状态" className="h-8 w-[min(20rem,70vw)]"><SelectValue /></SelectTrigger>
              <SelectContent>{operationsSources.map(item => <SelectItem key={item.sourceId} value={item.sourceId}>{item.displayName}</SelectItem>)}</SelectContent>
            </Select>
            {operationsConnector && <Button data-testid="sync-selected-source" variant="outline" size="sm" disabled={busy} onClick={() => syncOperationsSource()}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${(syncFilesystemSource.isPending || syncObjectStorageSource.isPending) ? "animate-spin" : ""}`} />立即同步
            </Button>}
          </div>
        </div>
        <div className="grid gap-px bg-border/60 sm:grid-cols-2 xl:grid-cols-6">
          {[
            ["最近状态", latestSourceRun ? SOURCE_RUN_LABELS[latestSourceRun.status] || latestSourceRun.status : "尚未同步"],
            ["上次成功", operationsSource?.lastSyncAt ? new Date(operationsSource.lastSyncAt).toLocaleString("zh-CN") : "-"],
            ["新增", latestSourceRun?.createdCount ?? 0],
            ["变化", latestSourceRun?.changedCount ?? 0],
            ["跳过", latestSourceRun?.unchangedCount ?? 0],
            ["删除候选", latestSourceRun?.missingCount ?? 0],
          ].map(([label, value]) => <div key={String(label)} data-testid={`source-run-${String(label)}`} className="min-w-0 bg-white px-4 py-3"><div className="truncate text-sm font-medium text-gray-900">{value}</div><div className="mt-1 text-xs text-muted-foreground">{label}</div></div>)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground">
          <div className="min-w-0">
            <span>在册 {sourceSyncStatus.data?.summary.active ?? 0}</span>
            <span className="mx-2">·</span><span>待退役 {sourceSyncStatus.data?.summary.missing ?? 0}</span>
            <span className="mx-2">·</span><span>Run {latestSourceRun?.runId || "-"}</span>
            {sourceRunError && <div className="mt-1 text-red-600">失败原因：{sourceRunError}</div>}
          </div>
          {latestSourceRun && ["failed", "partial"].includes(latestSourceRun.status) && operationsConnector && <Button data-testid="resume-source-sync" variant="outline" size="sm" disabled={busy} onClick={() => syncOperationsSource(latestSourceRun.runId)}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />恢复同步
          </Button>}
        </div>
      </Card>}

      <Card className="overflow-hidden border-border/50 bg-white/90">
        <div className="border-b px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900"><ListFilter className="h-4 w-4 text-primary" />{assetListMode === "remediation" ? "整改队列" : "全部资产"}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{assetListMode === "remediation" ? "按治理问题处理异常资产，正常资产无需逐份确认。" : "查看全部候选、审核和发布状态。"}</p>
            </div>
            <div className="flex rounded-[8px] border bg-white p-0.5">
              <Button size="sm" variant={assetListMode === "remediation" ? "default" : "ghost"} className={assetListMode === "remediation" ? "h-7 rounded-[6px] hover:bg-primary" : "h-7 rounded-[6px] text-muted-foreground hover:bg-primary/5 hover:text-foreground"} onClick={() => setAssetListMode("remediation")}>待整改 {issueCounts.all}</Button>
              <Button size="sm" variant={assetListMode === "all" ? "default" : "ghost"} className={assetListMode === "all" ? "h-7 rounded-[6px] hover:bg-primary" : "h-7 rounded-[6px] text-muted-foreground hover:bg-primary/5 hover:text-foreground"} onClick={() => setAssetListMode("all")}>全部资产 {data?.candidates.length || 0}</Button>
            </div>
          </div>
          {assetListMode === "remediation" && <div className="mt-3 flex flex-wrap gap-1.5">
            {ASSET_ISSUE_GROUPS.filter(group => group.id === "all" || issueCounts[group.id] > 0).map(group => <Button key={group.id} size="sm" variant={issueFilter === group.id ? "secondary" : "ghost"} className="h-7 px-2.5 text-xs" onClick={() => setIssueFilter(group.id)}>{group.label} {issueCounts[group.id]}</Button>)}
          </div>}
        </div>
        <div className="max-h-[70vh] divide-y overflow-y-auto">
          {visibleCandidates.map(candidate => {
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
                  {Array.isArray(suggestion.applicableRoles) && suggestion.applicableRoles.length > 0 && <div className="mt-1 text-xs text-muted-foreground">建议岗位：{suggestion.applicableRoles.map(roleId => data?.roles.find(role => role.id === String(roleId))?.name || String(roleId)).join("、")}</div>}
                  {Array.isArray(suggestion.logicalAssetCandidates) && suggestion.logicalAssetCandidates.length > 0 && <div className="mt-1 text-xs text-muted-foreground">逻辑资产候选：{suggestion.logicalAssetCandidates.map(String).join("、")}</div>}
                  <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Sparkles className="h-3 w-3" />{suggestionSourceLabel(suggestion.suggestionMethod)}{candidate.reviewedBy ? ` · 已由 ${candidate.reviewedBy} 确认` : " · 待人工确认"}</div>
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
          {!visibleCandidates.length && <div className="px-4 py-10 text-center text-sm text-muted-foreground">{assetListMode === "remediation" ? "当前筛选下没有待整改资产" : "暂无候选资产"}</div>}
        </div>
      </Card>

      <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>登记企业资产来源</DialogTitle><DialogDescription>登记权威来源和责任部门，正文或凭据不保存在这里。</DialogDescription></DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>来源 ID</Label><Input value={source.sourceId} onChange={e => setSource({ ...source, sourceId: e.target.value })} placeholder="bank-wealth-policy" /></div>
            <div><Label>名称</Label><Input value={source.displayName} onChange={e => setSource({ ...source, displayName: e.target.value })} /></div>
            <div><Label>来源类型</Label><Select value={source.sourceType} onValueChange={value => setSource({ ...source, sourceType: value as any })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[
              ["document_repository", "制度/文档库"], ["business_system", "业务系统"], ["rule_catalog", "规则目录"], ["workflow_catalog", "流程目录"], ["capability_service", "能力服务"], ["identity_directory", "IAM/组织目录"],
            ].map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>责任部门</Label><Input value={source.ownerDepartment} onChange={e => setSource({ ...source, ownerDepartment: e.target.value })} /></div>
            {source.sourceType === "document_repository" && <div className="sm:col-span-2">
              <Label>接入方式</Label>
              <Select value={sourceConnectionMode} onValueChange={value => setSourceConnectionMode(value as typeof sourceConnectionMode)}>
                <SelectTrigger aria-label="接入方式"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="address">通用来源地址</SelectItem>
                  <SelectItem value="filesystem">挂载目录 / NAS</SelectItem>
                  <SelectItem value="object_storage">OBS / S3 对象存储</SelectItem>
                </SelectContent>
              </Select>
            </div>}
            {(source.sourceType !== "document_repository" || sourceConnectionMode !== "object_storage") && <div className="sm:col-span-2"><Label>来源地址</Label><Input value={source.sourceUri} onChange={e => setSource({ ...source, sourceUri: e.target.value })} placeholder={sourceConnectionMode === "filesystem" ? "file:///mnt/knowledge" : "https://... 或内部来源标识"} /></div>}
            {source.sourceType === "document_repository" && sourceConnectionMode === "object_storage" && <div data-testid="object-storage-source-fields" className="sm:col-span-2 grid gap-3 rounded border border-border bg-white p-3 sm:grid-cols-2">
              <div><Label>协议</Label><Select value={objectStorage.scheme} onValueChange={value => setObjectStorage({ ...objectStorage, scheme: value as "obs" | "s3" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="obs">华为云 OBS</SelectItem><SelectItem value="s3">S3 兼容</SelectItem></SelectContent></Select></div>
              <div><Label>Region</Label><Input data-testid="object-storage-region" value={objectStorage.region} onChange={event => setObjectStorage({ ...objectStorage, region: event.target.value })} /></div>
              <div className="sm:col-span-2"><Label>Endpoint{objectStorage.scheme === "s3" ? "（AWS S3 可留空）" : ""}</Label><Input data-testid="object-storage-endpoint" value={objectStorage.endpoint} onChange={event => setObjectStorage({ ...objectStorage, endpoint: event.target.value })} placeholder="https://obs.cn-east-3.myhuaweicloud.com" /></div>
              <div><Label>Bucket</Label><Input data-testid="object-storage-bucket" value={objectStorage.bucket} onChange={event => setObjectStorage({ ...objectStorage, bucket: event.target.value })} /></div>
              <div><Label>Prefix</Label><Input data-testid="object-storage-prefix" value={objectStorage.prefix} onChange={event => setObjectStorage({ ...objectStorage, prefix: event.target.value })} placeholder="wealth/policy/" /></div>
              <div className="sm:col-span-2"><Label>凭据引用（Credential Reference）</Label><Input data-testid="object-storage-credential-ref" value={objectStorage.credentialRef} onChange={event => setObjectStorage({ ...objectStorage, credentialRef: event.target.value })} placeholder="env://GRACE_OBS" /></div>
              <label className="sm:col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={objectStorage.forcePathStyle} onChange={event => setObjectStorage({ ...objectStorage, forcePathStyle: event.target.checked })} />使用 Path-style 地址</label>
              <p className="sm:col-span-2 text-xs text-muted-foreground">这里只保存 Endpoint、Bucket、Prefix 与凭据引用。Access Key 和 Secret Key 必须由服务端 Secret/环境配置提供。</p>
            </div>}
            <div className="sm:col-span-2"><Label>责任人/联系方式</Label><Input value={source.ownerContact} onChange={e => setSource({ ...source, ownerContact: e.target.value })} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setSourceOpen(false)}>取消</Button><Button disabled={busy || (source.sourceType === "document_repository" && sourceConnectionMode === "object_storage" && ((objectStorage.scheme === "obs" && !objectStorage.endpoint.trim()) || !objectStorage.bucket.trim() || !objectStorage.credentialRef.trim()))} onClick={saveRegisteredSource}>{saveSource.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}保存</Button></DialogFooter>
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

            <div className="space-y-2 rounded border bg-white px-3 py-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={useModelSuggestion} onChange={event => { setUseModelSuggestion(event.target.checked); if (!event.target.checked) setAllowContentProcessing(false); }} />使用平台模型增强元数据建议</label>
              <label className={`flex items-center gap-2 text-sm ${useModelSuggestion ? "" : "text-muted-foreground"}`}><input type="checkbox" disabled={!useModelSuggestion} checked={allowContentProcessing} onChange={event => setAllowContentProcessing(event.target.checked)} />允许向平台模型发送文本文件的有限摘要</label>
              <p className="text-xs text-muted-foreground">模型只提供建议；权限、密级、生命周期和发布状态仍由确定性规则与人工审核决定。</p>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setDiscoveryOpen(false)}>取消</Button><Button disabled={busy || !discoverySourceId || (discoveryMode === "object_inventory" ? !inventoryText.trim() : !discoveryFiles.length)} onClick={doDiscover}>{discoverArtifacts.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}开始发现</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={filesystemSyncOpen} onOpenChange={setFilesystemSyncOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>同步挂载目录</DialogTitle>
            <DialogDescription>执行一次受限完整扫描。新增和变化生成候选；确认删除生成退役整改项；未变化文件跳过。同步不会自动审核或发布。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>目录来源</Label>
              <Select value={filesystemSyncSourceId} onValueChange={setFilesystemSyncSourceId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{filesystemSources.map(item => <SelectItem key={item.sourceId} value={item.sourceId}>{item.displayName} · {item.sourceUri}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2 rounded border bg-white px-3 py-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filesystemUseModelSuggestion} onChange={event => { setFilesystemUseModelSuggestion(event.target.checked); if (!event.target.checked) setFilesystemAllowContentProcessing(false); }} />使用平台模型增强元数据建议</label>
              <label className={`flex items-center gap-2 text-sm ${filesystemUseModelSuggestion ? "" : "text-muted-foreground"}`}><input type="checkbox" disabled={!filesystemUseModelSuggestion} checked={filesystemAllowContentProcessing} onChange={event => setFilesystemAllowContentProcessing(event.target.checked)} />允许向平台模型发送文本文件的有限摘要</label>
              <p className="text-xs text-muted-foreground">目录必须位于服务端白名单挂载根目录内；符号链接不会被扫描。</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFilesystemSyncOpen(false)}>取消</Button>
            <Button disabled={busy || !filesystemSyncSourceId} onClick={() => syncFilesystemSource.mutate({ sourceId: filesystemSyncSourceId, useModelSuggestion: filesystemUseModelSuggestion, allowContentProcessing: filesystemAllowContentProcessing })}>
              {syncFilesystemSource.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}开始同步
            </Button>
          </DialogFooter>
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
        <DialogContent className="flex w-[min(72rem,calc(100vw-2rem))] max-w-none flex-col sm:max-w-5xl max-h-[92vh] overflow-hidden bg-white p-0 shadow-2xl">
          <DialogHeader className="shrink-0 border-b px-6 py-4">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div><DialogTitle>确认企业资产信息</DialogTitle><DialogDescription className="mt-1">确认后进入独立审核，不会直接发布或提供给岗位员工。</DialogDescription></div>
              <Button variant="outline" size="sm" onClick={toggleAdvancedMetadata}>{advancedMetadata ? "返回字段表单" : "高级 JSON"}</Button>
            </div>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {advancedMetadata ? <div>
              <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">高级模式直接编辑治理契约。返回字段表单时会先校验 JSON，未知字段仍会保留。</div>
              <Textarea className="min-h-[32rem] font-mono text-xs" value={metadataText} onChange={e => setMetadataText(e.target.value)} />
            </div> : <div className="space-y-6">
              <section>
                <h4 className="text-sm font-semibold text-gray-900">基础信息</h4>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <div><Label>资产名称</Label><Input value={reviewDisplayName} onChange={event => setReviewDisplayName(event.target.value)} /><FieldProvenance candidate={reviewTarget!} field="displayName" extracted /></div>
                  <div><Label>版本</Label><Input value={reviewSourceVersion} onChange={event => setReviewSourceVersion(event.target.value)} /><FieldProvenance candidate={reviewTarget!} field="sourceVersion" extracted /></div>
                  <div><Label>资产类型</Label><Input value={reviewTarget ? TYPE_LABELS[reviewTarget.assetType] || reviewTarget.assetType : ""} disabled /></div>
                  <div><Label>接入来源</Label><Input value={data?.sources.find(source => source.sourceId === reviewTarget?.sourceId)?.displayName || reviewTarget?.sourceId || ""} disabled /></div>
                  <div className="sm:col-span-2"><Label>文件位置</Label><Input value={reviewTarget?.sourceUri || ""} disabled /></div>
                </div>
              </section>

              <section className="border-t pt-5">
                <h4 className="text-sm font-semibold text-gray-900">治理信息</h4>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div><Label>责任部门</Label><Input value={String(reviewMetadata.ownerDepartment || "")} onChange={event => updateMetadata("ownerDepartment", event.target.value)} /><FieldProvenance candidate={reviewTarget!} field="ownerDepartment" /></div>
                  <div><Label>信息分级</Label><Select value={String(reviewMetadata.classification || "internal")} onValueChange={value => updateMetadata("classification", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="public">公开</SelectItem><SelectItem value="internal">内部</SelectItem><SelectItem value="sensitive">敏感</SelectItem><SelectItem value="restricted">严格受限</SelectItem></SelectContent></Select><FieldProvenance candidate={reviewTarget!} field="classification" /></div>
                  <div><Label>权威等级</Label><Select value={String(reviewMetadata.authority || "reference")} onValueChange={value => updateMetadata("authority", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="official">正式制度</SelectItem><SelectItem value="approved">审核资料</SelectItem><SelectItem value="reference">参考资料</SelectItem><SelectItem value="personal">个人资料</SelectItem></SelectContent></Select><FieldProvenance candidate={reviewTarget!} field="authority" /></div>
                  <div><Label>生命周期</Label><Select value={String(reviewMetadata.lifecycle || "draft")} onValueChange={value => updateMetadata("lifecycle", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">草稿</SelectItem><SelectItem value="active">计划生效</SelectItem><SelectItem value="expired">已失效</SelectItem><SelectItem value="archived">已归档</SelectItem></SelectContent></Select><FieldProvenance candidate={reviewTarget!} field="lifecycle" /></div>
                  <div><Label>生效时间</Label><Input type="datetime-local" value={toLocalDateTimeInput(reviewMetadata.effectiveAt)} onChange={event => updateMetadata("effectiveAt", fromLocalDateTimeInput(event.target.value))} /><FieldProvenance candidate={reviewTarget!} field="effectiveAt" /></div>
                  <div><Label>失效时间</Label><Input type="datetime-local" value={toLocalDateTimeInput(reviewMetadata.expiresAt)} onChange={event => updateMetadata("expiresAt", fromLocalDateTimeInput(event.target.value))} /><FieldProvenance candidate={reviewTarget!} field="expiresAt" /></div>
                </div>
              </section>

              <section className="border-t pt-5">
                <h4 className="text-sm font-semibold text-gray-900">业务范围</h4>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <div><Label>业务域</Label><Select value={String(reviewMetadata.businessDomain || "general")} onValueChange={value => updateMetadata("businessDomain", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="wealth">财富管理</SelectItem><SelectItem value="insurance">保险业务</SelectItem><SelectItem value="risk">风险管理</SelectItem><SelectItem value="audit">智能审核</SelectItem><SelectItem value="investment_research">投研投顾</SelectItem><SelectItem value="general">通用</SelectItem></SelectContent></Select><FieldProvenance candidate={reviewTarget!} field="businessDomain" /></div>
                  <div><Label>适用机构</Label><Input value={stringList(reviewMetadata.applicableOrganizations).join("、")} onChange={event => updateMetadata("applicableOrganizations", stringList(event.target.value))} placeholder="留空表示由运行时机构范围控制" /><FieldProvenance candidate={reviewTarget!} field="applicableOrganizations" /></div>
                  <div className="sm:col-span-2">
                    <Label>适用岗位</Label>
                    <div className="mt-1.5 grid gap-2 rounded border px-3 py-3 sm:grid-cols-2 lg:grid-cols-3">
                      {(data?.roles || []).map(role => {
                        const checked = stringList(reviewMetadata.applicableRoles).includes(role.id);
                        return <label key={role.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={checked} onChange={event => updateMetadata("applicableRoles", event.target.checked ? [...stringList(reviewMetadata.applicableRoles), role.id] : stringList(reviewMetadata.applicableRoles).filter(item => item !== role.id))} />{role.name}</label>;
                      })}
                    </div>
                    <FieldProvenance candidate={reviewTarget!} field="applicableRoles" />
                  </div>
                </div>
              </section>

              <section className="border-t pt-5">
                <h4 className="text-sm font-semibold text-gray-900">岗位运行关联</h4>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <div><Label>逻辑资产标识</Label><Input value={stringList(reviewMetadata.logicalAssetIds).join("、")} onChange={event => updateMetadata("logicalAssetIds", stringList(event.target.value))} placeholder="例如 current_wealth_policy" /><FieldProvenance candidate={reviewTarget!} field="logicalAssetIds" /></div>
                  <div><Label>关联岗位任务</Label><Input value={stringList(reviewMetadata.relatedTasks).join("、")} onChange={event => updateMetadata("relatedTasks", stringList(event.target.value))} placeholder="例如 WM-GT-02、WM-GT-03" /><FieldProvenance candidate={reviewTarget!} field="relatedTasks" /></div>
                  <div><Label>文档系列标识</Label><Input value={String(reviewMetadata.documentSeriesId || "")} onChange={event => updateMetadata("documentSeriesId", event.target.value || null)} /><FieldProvenance candidate={reviewTarget!} field="documentSeriesId" /></div>
                  <div><Label>替代版本标识</Label><Input value={String(reviewMetadata.supersedes || "")} onChange={event => updateMetadata("supersedes", event.target.value || null)} placeholder="没有替代关系时留空" /><FieldProvenance candidate={reviewTarget!} field="supersedes" /></div>
                </div>
                <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(reviewMetadata.externalProcessingAllowed)} onChange={event => updateMetadata("externalProcessingAllowed", event.target.checked)} />允许按企业策略进行外部模型处理</label>
              </section>

              <section className="border-t pt-5">
                <h4 className="text-sm font-semibold text-gray-900">建议与问题依据</h4>
                <div className="mt-2 rounded border bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5 font-medium text-foreground"><Sparkles className="h-3.5 w-3.5 text-primary" />{suggestionSourceLabel(recordOf(reviewTarget?.suggestedMetadataJson).suggestionMethod)}</div>
                  <div className="mt-1">{suggestionSourceEvidence(recordOf(reviewTarget?.suggestedMetadataJson).suggestionMethod)}</div>
                  {candidateDiagnostics(reviewTarget!).map((diagnostic, index) => <div key={`${String(diagnostic.code)}-${index}`} className="mt-1.5 flex items-start gap-1.5 text-amber-700"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{String(diagnostic.message || diagnostic.code)}</div>)}
                  <div className="mt-2">字段建议不代表资产可信度；责任部门、权威等级、生效时间和正式替代关系以人工确认为准。</div>
                </div>
              </section>
            </div>}
          </div>
          <DialogFooter className="shrink-0 border-t px-6 py-4"><Button variant="outline" onClick={() => setReviewTarget(null)}>取消</Button><Button disabled={busy || !reviewDisplayName.trim() || !reviewSourceVersion.trim() || !String(reviewMetadata.ownerDepartment || "").trim() || !stringList(reviewMetadata.applicableRoles).length} onClick={doSubmitReview}>提交审核</Button></DialogFooter>
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
