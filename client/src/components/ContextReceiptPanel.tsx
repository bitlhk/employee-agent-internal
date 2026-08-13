import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  EyeOff,
  Pencil,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import type { ContextReceiptV1 } from "@shared/context-receipt";
import type { ContextInteractionGrantV1 } from "@shared/context-evidence";

type CitedKnowledge = {
  documentId: string;
  documentName: string;
  documentVersion?: string;
};

type MemoryPreview = { memoryId: number; version: number; safePreview: string; sourceType: string; asOf: string };

function statusLabel(status: ContextReceiptV1["readiness"]["status"]): string {
  if (status === "READY") return "当前就绪";
  if (status === "DEGRADED") return "有限可用";
  return "暂不可完成";
}

function formatAsOf(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "时间待核实";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function ContextReceiptPanel({
  receipt,
  interactionGrant,
  citedKnowledge = [],
  onMemoryFeedback,
  onLoadMemoryPreviews,
}: {
  receipt: ContextReceiptV1;
  interactionGrant?: ContextInteractionGrantV1;
  citedKnowledge?: CitedKnowledge[];
  onMemoryFeedback?: (input: {
    memoryId: number;
    memoryVersion: number;
    receiptId: string;
    feedbackToken: string;
    action: "correct" | "update" | "hide";
    content?: string;
  }) => Promise<void> | void;
  onLoadMemoryPreviews?: (input: {
    receiptId: string;
    feedbackToken: string;
    memories: Array<{ memoryId: number; memoryVersion: number }>;
  }) => Promise<MemoryPreview[]>;
}) {
  const [open, setOpen] = useState(false);
  const [ignoredMemoryIds, setIgnoredMemoryIds] = useState<Set<string>>(new Set());
  const [pendingMemoryId, setPendingMemoryId] = useState("");
  const [updatingMemoryId, setUpdatingMemoryId] = useState("");
  const [memoryUpdate, setMemoryUpdate] = useState("");
  const [memoryPreviews, setMemoryPreviews] = useState<Record<string, MemoryPreview>>({});
  const [memoryPreviewLoading, setMemoryPreviewLoading] = useState(false);
  const [memoryPreviewRequested, setMemoryPreviewRequested] = useState(false);
  const [confirmedMemoryIds, setConfirmedMemoryIds] = useState<Set<string>>(new Set());
  const providedCount = receipt.provided.knowledge.length
    + receipt.provided.businessData.length
    + receipt.provided.memory.length;
  const latestDataAt = useMemo(() => receipt.provided.businessData
    .map((item) => item.asOf)
    .filter(Boolean)
    .sort()
    .at(-1) || "", [receipt.provided.businessData]);
  const cited = citedKnowledge.length || receipt.cited.knowledgeAssetIds.length;
  const appliedPolicies = receipt.applied.policyDecisions.length;
  const executions = receipt.applied.capabilityExecutions;
  const disclosedExclusions = receipt.excluded.filter((item) => item.disclosure !== "hidden");

  useEffect(() => {
    if (!open || !interactionGrant || !onLoadMemoryPreviews || receipt.provided.memory.length === 0) return;
    if (memoryPreviewRequested || memoryPreviewLoading) return;
    setMemoryPreviewRequested(true);
    setMemoryPreviewLoading(true);
    void onLoadMemoryPreviews({
      receiptId: receipt.receiptId,
      feedbackToken: interactionGrant.token,
      memories: receipt.provided.memory.map((item) => ({
        memoryId: Number(item.memoryId),
        memoryVersion: item.version,
      })),
    }).then((rows) => {
      setMemoryPreviews(Object.fromEntries(rows.map((item) => [String(item.memoryId), item])));
    }).catch(() => undefined).finally(() => setMemoryPreviewLoading(false));
  }, [interactionGrant, memoryPreviewLoading, memoryPreviewRequested, onLoadMemoryPreviews, open, receipt.provided.memory, receipt.receiptId]);

  return (
    <section className="context-receipt" data-status={receipt.readiness.status.toLowerCase()} aria-label="本次分析依据">
      <button
        type="button"
        className="context-receipt__summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="context-receipt__summary-title"><ShieldCheck />本次依据</span>
        <span className="context-receipt__summary-items">
          {providedCount > 0 ? <span>{providedCount} 项企业上下文</span> : null}
          {latestDataAt ? <span>数据 {formatAsOf(latestDataAt)}</span> : null}
          {cited > 0 ? <span>引用 {cited} 项</span> : null}
          {receipt.provided.memory.length > 0 ? <span>岗位记忆 {receipt.provided.memory.length} 条</span> : null}
          <span className="context-receipt__status">{statusLabel(receipt.readiness.status)}</span>
        </span>
        <ChevronDown className="context-receipt__chevron" data-open={open} aria-hidden="true" />
      </button>

      {open ? (
        <div className="context-receipt__details">
          <header className="context-receipt__heading">
            <div>
              <strong>{receipt.taskLabel || receipt.taskId}</strong>
              <span>展示本次任务实际获得、引用和应用的依据。</span>
            </div>
            <span className="context-receipt__status">{statusLabel(receipt.readiness.status)}</span>
          </header>

          {receipt.provided.businessData.length > 0 ? (
            <div className="context-receipt__section">
              <h4><Database />业务现场</h4>
              <ul>
                {receipt.provided.businessData.map((item) => (
                  <li key={`${item.sourceSystem}:${item.entityRef}`}>
                    <span>{item.label}</span>
                    <small>{item.asOf ? `更新于 ${formatAsOf(item.asOf)}` : "数据时间待核实"}</small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {(receipt.provided.knowledge.length > 0 || citedKnowledge.length > 0) ? (
            <div className="context-receipt__section">
              <h4><BookOpen />现行依据</h4>
              <ul>
                {receipt.provided.knowledge.map((item) => (
                  <li key={item.assetId}>
                    <span>{item.label}</span>
                    <small>{item.version ? `版本 ${item.version}` : "版本已绑定"} · 已提供</small>
                  </li>
                ))}
                {citedKnowledge.map((item) => (
                  <li key={`cited:${item.documentId}`}>
                    <span>{item.documentName}</span>
                    <small>{item.documentVersion ? `版本 ${item.documentVersion} · ` : ""}回答已引用</small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {receipt.provided.memory.length > 0 ? (
            <div className="context-receipt__section">
              <h4><Brain />岗位连续性</h4>
              <p>本次结合了 {receipt.provided.memory.length} 条当前有效的岗位记忆；记忆不替代 CRM 事实或现行制度。</p>
              {onMemoryFeedback && interactionGrant?.token ? (
                <div className="context-receipt__memory-feedback">
                  {receipt.provided.memory.map((item, index) => ignoredMemoryIds.has(item.memoryId) ? null : (
                    <div key={item.memoryId}>
                      <span>
                        {memoryPreviews[item.memoryId]?.safePreview || (memoryPreviewLoading ? "正在读取记忆摘要..." : `岗位记忆 ${index + 1}`)}
                        <small>版本 {item.version} · 仅作参考，不替代业务事实</small>
                      </span>
                      <span className="context-receipt__memory-actions">
                        <button
                          type="button"
                          disabled={pendingMemoryId === item.memoryId || confirmedMemoryIds.has(item.memoryId)}
                          onClick={async () => {
                            setPendingMemoryId(item.memoryId);
                            try {
                              await onMemoryFeedback({ memoryId: Number(item.memoryId), memoryVersion: item.version, receiptId: receipt.receiptId, feedbackToken: interactionGrant.token, action: "correct" });
                              setConfirmedMemoryIds((current) => new Set(current).add(item.memoryId));
                            } finally {
                              setPendingMemoryId("");
                            }
                          }}
                        ><Check />{confirmedMemoryIds.has(item.memoryId) ? "已确认" : "正确"}</button>
                        <button type="button" onClick={() => { setUpdatingMemoryId(item.memoryId); setMemoryUpdate(""); }}><Pencil />更新</button>
                        <button
                          type="button"
                          onClick={async () => {
                            await onMemoryFeedback({ memoryId: Number(item.memoryId), memoryVersion: item.version, receiptId: receipt.receiptId, feedbackToken: interactionGrant.token, action: "hide" });
                            setIgnoredMemoryIds((current) => new Set(current).add(item.memoryId));
                          }}
                        ><EyeOff />隐藏这条提示</button>
                      </span>
                      {updatingMemoryId === item.memoryId ? (
                        <form onSubmit={async (event) => {
                          event.preventDefault();
                          const content = memoryUpdate.trim();
                          if (content.length < 4) return;
                          setPendingMemoryId(item.memoryId);
                          try {
                            await onMemoryFeedback({ memoryId: Number(item.memoryId), memoryVersion: item.version, receiptId: receipt.receiptId, feedbackToken: interactionGrant.token, action: "update", content });
                            setUpdatingMemoryId("");
                            setMemoryUpdate("");
                          } finally {
                            setPendingMemoryId("");
                          }
                        }}>
                          <input value={memoryUpdate} onChange={(event) => setMemoryUpdate(event.target.value)} maxLength={800} placeholder="输入更新后的岗位记忆" aria-label="更新岗位记忆" />
                          <button type="submit" disabled={pendingMemoryId === item.memoryId || memoryUpdate.trim().length < 4}>保存</button>
                          <button type="button" onClick={() => setUpdatingMemoryId("")}>取消</button>
                        </form>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {(appliedPolicies > 0 || executions.length > 0) ? (
            <div className="context-receipt__section">
              <h4><ShieldCheck />治理与执行</h4>
              <ul>
                {appliedPolicies > 0 ? (
                  <li><span>已应用 {appliedPolicies} 项确定性治理判断</span><small>不是模型自我声明</small></li>
                ) : null}
                {executions.map((item) => (
                  <li key={`${item.capabilityId}:${item.requestId || item.operation}`}>
                    <span>{item.label || item.operation}</span>
                    <small>
                      {item.status === "completed" ? "已完成" : item.status === "blocked" ? "已阻止" : item.status === "failed" ? "执行失败" : "待执行"}
                      {item.approvalId ? " · 已人工确认" : ""}
                      {item.idempotencyProtected ? " · 已防重复" : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {disclosedExclusions.length > 0 ? (
            <div className="context-receipt__section context-receipt__section--excluded">
              <h4><Wrench />已排除</h4>
              <ul>{disclosedExclusions.map((item) => (
                <li key={`${item.category}:${item.reasonCode}`}>
                  <span>{item.message}</span>
                  <small>{item.disclosure === "exact_count" ? `${item.count} 项` : "已按安全规则汇总"}</small>
                </li>
              ))}</ul>
            </div>
          ) : null}

          <div className="context-receipt__readiness">
            <CheckCircle2 aria-hidden="true" />
            <span>
              <strong>{statusLabel(receipt.readiness.status)}</strong>
              {receipt.readiness.reasons.length > 0
                ? <small>{receipt.readiness.reasons.join("；")}</small>
                : <small>当前任务所需身份、依据和能力已完成核验。</small>}
            </span>
          </div>

          {(receipt.readiness.presentation.completed.length
            || receipt.readiness.presentation.unavailable.length
            || receipt.readiness.presentation.nextSteps.length) ? (
            <div className="context-receipt__section context-receipt__readiness-outcomes">
              {receipt.readiness.presentation.completed.length ? (
                <div><strong>已完成或当前可完成</strong><ul>{receipt.readiness.presentation.completed.map((item) => <li key={item}>{item}</li>)}</ul></div>
              ) : null}
              {receipt.readiness.presentation.unavailable.length ? (
                <div><strong>暂不能完成</strong><ul>{receipt.readiness.presentation.unavailable.map((item) => <li key={item}>{item}</li>)}</ul></div>
              ) : null}
              {receipt.readiness.presentation.nextSteps.length ? (
                <div><strong>下一步</strong><ul>{receipt.readiness.presentation.nextSteps.map((item) => <li key={item}>{item}</li>)}</ul></div>
              ) : null}
            </div>
          ) : null}

          <details className="context-receipt__technical">
            <summary>技术凭据</summary>
            <dl>
              <div><dt>收据</dt><dd>{receipt.receiptId}</dd></div>
              <div><dt>上下文指纹</dt><dd>{receipt.receiptFingerprint}</dd></div>
              <div><dt>身份指纹</dt><dd>{receipt.principalFingerprint}</dd></div>
              <div><dt>能力数</dt><dd>{receipt.provided.capabilities.length}</dd></div>
            </dl>
          </details>
        </div>
      ) : null}
    </section>
  );
}
