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
import { Check, FileInput, Loader2, PackageCheck, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";

type Overview = RouterOutputs["enterpriseAssets"]["overview"];
type Candidate = Overview["candidates"][number];

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿", review_pending: "待审核", approved: "审核通过", rejected: "已退回", published: "已发布", stale: "已失效",
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

export function EnterpriseAssetsPanel() {
  const utils = trpc.useUtils();
  const { data, isLoading, refetch } = trpc.enterpriseAssets.overview.useQuery({});
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState({ ...EMPTY_SOURCE });
  const [importOpen, setImportOpen] = useState(false);
  const [importSourceId, setImportSourceId] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [reviewTarget, setReviewTarget] = useState<Candidate | null>(null);
  const [metadataText, setMetadataText] = useState("");
  const [rejectTarget, setRejectTarget] = useState<Candidate | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [publishTarget, setPublishTarget] = useState<Candidate | null>(null);
  const [targetAssetId, setTargetAssetId] = useState("");

  const invalidate = async () => utils.enterpriseAssets.overview.invalidate();
  const saveSource = trpc.enterpriseAssets.saveSource.useMutation({
    onSuccess: async () => { toast.success("接入来源已保存"); setSourceOpen(false); setSource({ ...EMPTY_SOURCE }); await invalidate(); },
    onError: error => toast.error(error.message),
  });
  const importManifest = trpc.enterpriseAssets.importManifest.useMutation({
    onSuccess: async result => { toast.success(`已导入 ${result.imported} 个候选资产`); setImportOpen(false); setManifestText(""); await invalidate(); },
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

  const activeSources = useMemo(() => (data?.sources || []).filter(item => item.status === "active"), [data?.sources]);
  const busy = saveSource.isPending || importManifest.isPending || submitReview.isPending || review.isPending || publish.isPending;

  const openReview = (candidate: Candidate) => {
    const suggested = { ...((candidate.suggestedMetadataJson || {}) as Record<string, unknown>) };
    delete suggested.enterpriseId;
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

  if (isLoading) return <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">企业岗位资产接入</h2>
          <p className="mt-1 text-xs text-muted-foreground">候选资产经人工确认后映射到现有 Runtime 资产；不会产生第二套运行配置。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />刷新</Button>
          <Button variant="outline" size="sm" onClick={() => { setImportSourceId(activeSources[0]?.sourceId || ""); setImportOpen(true); }} disabled={!activeSources.length}>
            <FileInput className="mr-1.5 h-3.5 w-3.5" />导入 Manifest
          </Button>
          <Button size="sm" onClick={() => setSourceOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" />登记来源</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ["接入来源", data?.summary.sources || 0], ["待审核", data?.summary.pendingReview || 0], ["审核通过", data?.summary.approved || 0],
          ["已发布", data?.summary.published || 0], ["待重验", data?.summary.stale || 0],
        ].map(([label, value]) => <Card key={String(label)} className="p-3"><div className="text-xl font-semibold text-gray-900">{value}</div><div className="mt-1 text-xs text-muted-foreground">{label}</div></Card>)}
      </div>

      <Card className="overflow-hidden border-border/50 bg-white/90">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-900">资产候选与发布状态</h3>
        </div>
        <div className="divide-y">
          {(data?.candidates || []).map(candidate => {
            const impact = (candidate.impactAnalysisJson || {}) as any;
            return (
              <div key={candidate.candidateId} className="flex flex-col gap-3 px-4 py-4 xl:flex-row xl:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-900">{candidate.displayName}</span>
                    <Badge variant="outline">{TYPE_LABELS[candidate.assetType] || candidate.assetType}</Badge>
                    <Badge variant={candidate.status === "published" ? "default" : "secondary"}>{STATUS_LABELS[candidate.status] || candidate.status}</Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{candidate.enterpriseAssetId} · v{candidate.sourceVersion} · {candidate.sourceId}</div>
                  {candidate.targetAssetId && <div className="mt-1 text-xs text-emerald-700">Runtime 映射：{candidate.targetAssetType} / {candidate.targetAssetId}</div>}
                  {Array.isArray(impact.affectedTaskIds) && impact.affectedTaskIds.length > 0 && <div className="mt-1 text-xs text-amber-700">需重跑：{impact.affectedTaskIds.join("、")}</div>}
                  {candidate.reviewNote && <div className="mt-1 text-xs text-red-600">评审意见：{candidate.reviewNote}</div>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {(["draft", "rejected"] as string[]).includes(candidate.status) && <Button variant="outline" size="sm" onClick={() => openReview(candidate)}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />提交审核</Button>}
                  {candidate.status === "review_pending" && <>
                    <Button size="sm" onClick={() => review.mutate({ candidateId: candidate.candidateId, decision: "approve" })}><Check className="mr-1.5 h-3.5 w-3.5" />通过</Button>
                    <Button variant="outline" size="sm" onClick={() => setRejectTarget(candidate)}><X className="mr-1.5 h-3.5 w-3.5" />退回</Button>
                  </>}
                  {candidate.status === "approved" && <Button size="sm" onClick={() => { setPublishTarget(candidate); setTargetAssetId(""); }}><PackageCheck className="mr-1.5 h-3.5 w-3.5" />发布映射</Button>}
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

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>导入岗位资产 Manifest</DialogTitle><DialogDescription>仅接收 `linggan.enterprise-asset/v1`，单次最多 100 个候选资产。</DialogDescription></DialogHeader>
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
    </div>
  );
}
