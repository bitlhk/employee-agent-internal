import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Maximize2,
  MessageSquareText,
  Network,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

type MemoryKind = "preference" | "instruction" | "entity" | "procedure";
type MemorySynthesisSlot = "profile" | "recent" | "playbook";
type GraphLayer = "L1" | "L2" | "L3";

type MemoryGraphItem = {
  id: number;
  kind: MemoryKind;
  status: string;
  content: string;
  evidenceCount: number;
  updatedAt: string;
};

type MemoryGraphEvidence = {
  id: number;
  memoryId: number;
  channel: string;
  snippet?: string | null;
  observedAt: string;
};

type MemoryGraphSynthesis = {
  id: number;
  slot: MemorySynthesisSlot;
  content: string;
  memoryIds: number[];
  confidence: number;
  generatedAt: string;
};

type GraphNode = {
  id: string;
  layer: GraphLayer;
  group: string;
  x: number;
  y: number;
  radius: number;
  label: string;
  detail: string;
  memoryId?: number;
  memoryIds: number[];
  status?: string;
  timestamp?: string;
};

type GraphEdge = { source: string; target: string; kind: "evidence" | "synthesis" };
type GraphCluster = {
  id: string;
  layer: GraphLayer;
  key: string;
  label: string;
  count: number;
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
};

const GRAPH_SIZE = 1200;
const CENTER = GRAPH_SIZE / 2;
const MAX_MEMORY_NODES = 90;
const MAX_EVIDENCE_NODES = 120;

const KIND_LABELS: Record<MemoryKind, string> = {
  preference: "表达偏好",
  instruction: "工作习惯",
  entity: "事项约定",
  procedure: "岗位流程",
};

const SLOT_LABELS: Record<MemorySynthesisSlot, string> = {
  profile: "工作画像",
  recent: "近期变化",
  playbook: "岗位方法",
};

const CHANNEL_LABELS: Record<string, string> = {
  web: "网页对话",
  feishu: "飞书",
  weixin: "微信",
  wecom: "企业微信",
  dingtalk: "钉钉",
  conversation: "对话",
  "web-settings": "手工添加",
};

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function annularPath(cluster: GraphCluster): string {
  const { startAngle, endAngle, innerRadius, outerRadius } = cluster;
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const outerStart = [CENTER + Math.cos(startAngle) * outerRadius, CENTER + Math.sin(startAngle) * outerRadius];
  const outerEnd = [CENTER + Math.cos(endAngle) * outerRadius, CENTER + Math.sin(endAngle) * outerRadius];
  const innerEnd = [CENTER + Math.cos(endAngle) * innerRadius, CENTER + Math.sin(endAngle) * innerRadius];
  const innerStart = [CENTER + Math.cos(startAngle) * innerRadius, CENTER + Math.sin(startAngle) * innerRadius];
  return [
    `M ${outerStart[0]} ${outerStart[1]}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd[0]} ${outerEnd[1]}`,
    `L ${innerEnd[0]} ${innerEnd[1]}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart[0]} ${innerStart[1]}`,
    "Z",
  ].join(" ");
}

function makeClusters(
  layer: GraphLayer,
  groups: Array<{ key: string; label: string; count: number }>,
  innerRadius: number,
  outerRadius: number,
): GraphCluster[] {
  if (!groups.length) return [];
  const gap = layer === "L3" ? 0.18 : 0.055;
  const weightTotal = groups.reduce((sum, group) => sum + group.count + 2, 0);
  let cursor = -Math.PI / 2;
  return groups.map((group) => {
    const span = Math.PI * 2 * ((group.count + 2) / weightTotal);
    const cluster = {
      id: `${layer}:${group.key}`,
      layer,
      key: group.key,
      label: group.label,
      count: group.count,
      startAngle: cursor + gap / 2,
      endAngle: cursor + span - gap / 2,
      innerRadius,
      outerRadius,
    };
    cursor += span;
    return cluster;
  });
}

function positionsForCluster(cluster: GraphCluster, count: number): Array<{ x: number; y: number }> {
  if (!count) return [];
  const radialRows = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count))));
  const columns = Math.ceil(count / radialRows);
  const span = cluster.endAngle - cluster.startAngle;
  const radialSpan = cluster.outerRadius - cluster.innerRadius;
  return Array.from({ length: count }, (_, index) => {
    const row = index % radialRows;
    const column = Math.floor(index / radialRows);
    const columnOffset = row % 2 ? 0.22 : 0;
    const angleProgress = (column + 0.5 + columnOffset) / Math.max(1, columns);
    const angle = cluster.startAngle + Math.min(0.96, angleProgress) * span;
    const radius = cluster.innerRadius + 10 + ((row + 0.5) / radialRows) * Math.max(8, radialSpan - 20);
    return {
      x: CENTER + Math.cos(angle) * radius,
      y: CENTER + Math.sin(angle) * radius,
    };
  });
}

function buildGraph(
  items: MemoryGraphItem[],
  evidence: MemoryGraphEvidence[],
  syntheses: MemoryGraphSynthesis[],
) {
  const visibleItems = items
    .filter((item) => item.status === "active" || item.status === "candidate")
    .slice(0, MAX_MEMORY_NODES);
  const itemIds = new Set(visibleItems.map((item) => item.id));
  const visibleEvidence = evidence
    .filter((entry) => itemIds.has(entry.memoryId))
    .slice(0, MAX_EVIDENCE_NODES);
  const visibleSyntheses = syntheses.filter((item) => item.memoryIds.some((id) => itemIds.has(id))).slice(0, 16);

  const synthesisGroups = (Object.keys(SLOT_LABELS) as MemorySynthesisSlot[])
    .map((key) => ({ key, label: SLOT_LABELS[key], count: visibleSyntheses.filter((item) => item.slot === key).length }))
    .filter((group) => group.count > 0);
  const memoryGroups = (Object.keys(KIND_LABELS) as MemoryKind[])
    .map((key) => ({ key, label: KIND_LABELS[key], count: visibleItems.filter((item) => item.kind === key).length }))
    .filter((group) => group.count > 0);
  const channels = Array.from(new Set(visibleEvidence.map((entry) => entry.channel)));
  const evidenceGroups = channels
    .map((key) => ({ key, label: CHANNEL_LABELS[key] || key || "其他来源", count: visibleEvidence.filter((entry) => entry.channel === key).length }))
    .filter((group) => group.count > 0);

  const clusters = [
    ...makeClusters("L3", synthesisGroups, 78, 190),
    ...makeClusters("L2", memoryGroups, 236, 356),
    ...makeClusters("L1", evidenceGroups, 402, 548),
  ];
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const group of synthesisGroups) {
    const rows = visibleSyntheses.filter((item) => item.slot === group.key);
    const positions = positionsForCluster(clusterById.get(`L3:${group.key}`)!, rows.length);
    rows.forEach((item, index) => nodes.push({
      id: `synthesis-${item.id}`,
      layer: "L3",
      group: group.key,
      ...positions[index],
      radius: 7.5,
      label: SLOT_LABELS[item.slot],
      detail: item.content,
      memoryIds: item.memoryIds.filter((id) => itemIds.has(id)),
      timestamp: item.generatedAt,
    }));
  }

  for (const group of memoryGroups) {
    const rows = visibleItems.filter((item) => item.kind === group.key);
    const positions = positionsForCluster(clusterById.get(`L2:${group.key}`)!, rows.length);
    rows.forEach((item, index) => nodes.push({
      id: `memory-${item.id}`,
      layer: "L2",
      group: group.key,
      ...positions[index],
      radius: item.status === "candidate" ? 4.8 : Math.min(8.5, 5.5 + Math.log2(Math.max(1, item.evidenceCount)) * 0.7),
      label: KIND_LABELS[item.kind],
      detail: item.content,
      memoryId: item.id,
      memoryIds: [item.id],
      status: item.status,
      timestamp: item.updatedAt,
    }));
  }

  for (const group of evidenceGroups) {
    const rows = visibleEvidence.filter((entry) => entry.channel === group.key);
    const positions = positionsForCluster(clusterById.get(`L1:${group.key}`)!, rows.length);
    rows.forEach((entry, index) => nodes.push({
      id: `evidence-${entry.id}`,
      layer: "L1",
      group: group.key,
      ...positions[index],
      radius: 2.8,
      label: CHANNEL_LABELS[entry.channel] || entry.channel || "协作依据",
      detail: entry.snippet || "这条依据已隐藏或来自明确确认。",
      memoryId: entry.memoryId,
      memoryIds: [entry.memoryId],
      timestamp: entry.observedAt,
    }));
  }

  visibleSyntheses.forEach((item) => item.memoryIds.forEach((memoryId) => {
    if (itemIds.has(memoryId)) edges.push({ source: `synthesis-${item.id}`, target: `memory-${memoryId}`, kind: "synthesis" });
  }));
  visibleEvidence.forEach((entry) => edges.push({
    source: `memory-${entry.memoryId}`,
    target: `evidence-${entry.id}`,
    kind: "evidence",
  }));

  return {
    nodes,
    edges,
    clusters,
    hiddenCount: Math.max(0, items.length - visibleItems.length)
      + Math.max(0, evidence.filter((entry) => itemIds.has(entry.memoryId)).length - visibleEvidence.length),
  };
}

function layerDescription(node: GraphNode) {
  if (node.layer === "L3") return "L3 · 综合认知";
  if (node.layer === "L2") return node.status === "candidate" ? "L2 · 记忆事实 · 学习中" : "L2 · 记忆事实 · 已确认";
  return "L1 · 原始事件";
}

export function MemoryGraphView({
  items,
  evidence,
  syntheses,
  onOpenMemory,
}: {
  items: MemoryGraphItem[];
  evidence: MemoryGraphEvidence[];
  syntheses: MemoryGraphSynthesis[];
  onOpenMemory?: (id: number) => void;
}) {
  const graph = useMemo(() => buildGraph(items, evidence, syntheses), [evidence, items, syntheses]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const adjacency = useMemo(() => {
    const map = new Map<string, string[]>();
    graph.edges.forEach((edge) => {
      map.set(edge.source, [...(map.get(edge.source) || []), edge.target]);
      map.set(edge.target, [...(map.get(edge.target) || []), edge.source]);
    });
    return map;
  }, [graph.edges]);
  const [layerVisibility, setLayerVisibility] = useState<Record<GraphLayer, boolean>>({ L1: true, L2: true, L3: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const activeNode = nodeById.get(hoveredId || selectedId || "") || null;
  const visibleNode = useCallback((node: GraphNode) => layerVisibility[node.layer], [layerVisibility]);
  const highlightedIds = useMemo(() => {
    if (!activeNode) return null;
    const seen = new Set<string>([activeNode.id]);
    let frontier = [activeNode.id];
    for (let depth = 0; depth < 2; depth += 1) {
      const next: string[] = [];
      frontier.forEach((id) => (adjacency.get(id) || []).forEach((neighbor) => {
        if (!seen.has(neighbor)) { seen.add(neighbor); next.push(neighbor); }
      }));
      frontier = next;
    }
    return seen;
  }, [activeNode, adjacency]);
  const visibleEdges = useMemo(() => graph.edges.filter((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    return Boolean(source && target && visibleNode(source) && visibleNode(target));
  }), [graph.edges, nodeById, visibleNode]);
  const layerCounts = useMemo(() => ({
    L1: graph.nodes.filter((node) => node.layer === "L1").length,
    L2: graph.nodes.filter((node) => node.layer === "L2").length,
    L3: graph.nodes.filter((node) => node.layer === "L3").length,
  }), [graph.nodes]);

  const zoom = (factor: number) => setView((current) => ({
    ...current,
    scale: Math.min(3.2, Math.max(0.55, current.scale * factor)),
  }));
  const fit = () => setView({ scale: 1, x: 0, y: 0 });
  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest("[data-memory-node]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: view.x, startY: view.y };
  };
  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = GRAPH_SIZE / Math.max(1, Math.min(bounds.width, bounds.height));
    setView((current) => ({
      ...current,
      x: drag.startX + (event.clientX - drag.x) * ratio,
      y: drag.startY + (event.clientY - drag.y) * ratio,
    }));
  };
  const stopDragging = () => { dragRef.current = null; };

  return (
    <section className="memory-graph" aria-label="记忆图谱">
      <header className="memory-graph__header">
        <div><h2>记忆图谱</h2><p>L3 综合认知位于中心，L2 记忆事实居中，L1 原始事件分布在外圈。</p></div>
        <div className="memory-graph__layer-toggles" aria-label="显示层级">
          {(["L3", "L2", "L1"] as const).map((layer) => (
            <button key={layer} type="button" data-active={layerVisibility[layer]} onClick={() => setLayerVisibility((current) => ({ ...current, [layer]: !current[layer] }))}>
              <i className={`is-${layer.toLowerCase()}`} aria-hidden="true" />{layer}
            </button>
          ))}
        </div>
      </header>

      <div className="memory-graph__canvas">
        {!graph.nodes.length ? <div className="memory-empty"><Network /><strong>还没有可展示的记忆关系</strong><span>新增原始事件或记忆事实后，图谱会自动形成。</span></div> : <>
          <svg
            viewBox={`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`}
            role="img"
            aria-label="岗位智能体三层记忆关系图"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onPointerLeave={stopDragging}
            onWheel={(event) => { event.preventDefault(); zoom(event.deltaY > 0 ? 0.9 : 1.1); }}
          >
            <g transform={`translate(${view.x} ${view.y}) translate(${CENTER} ${CENTER}) scale(${view.scale}) translate(${-CENTER} ${-CENTER})`}>
              <g className="memory-graph__cluster-rings">
                {graph.clusters.filter((cluster) => layerVisibility[cluster.layer]).map((cluster) => <path key={cluster.id} d={annularPath(cluster)} data-layer={cluster.layer} />)}
              </g>
              <g className="memory-graph__cluster-labels" aria-hidden="true">
                {graph.clusters.filter((cluster) => layerVisibility[cluster.layer]).map((cluster) => {
                  const angle = (cluster.startAngle + cluster.endAngle) / 2;
                  const radius = cluster.outerRadius + (cluster.layer === "L1" ? 25 : 13);
                  return <g key={cluster.id} transform={`translate(${CENTER + Math.cos(angle) * radius} ${CENTER + Math.sin(angle) * radius})`}>
                    <text textAnchor="middle" y="-4">{cluster.label}</text>
                    <text className="is-count" textAnchor="middle" y="14">{cluster.count} {cluster.layer === "L1" ? "条事件" : cluster.layer === "L2" ? "条事实" : "条认知"}</text>
                  </g>;
                })}
              </g>
              {layerVisibility.L3 ? <g className="memory-graph__center" aria-hidden="true">
                <circle cx={CENTER} cy={CENTER} r="54" />
                <text x={CENTER} y={CENTER - 7} textAnchor="middle">L3</text>
                <text className="is-subtitle" x={CENTER} y={CENTER + 17} textAnchor="middle">综合认知</text>
              </g> : null}
              <g className="memory-graph__edges">
                {visibleEdges.map((edge) => {
                  const source = nodeById.get(edge.source)!;
                  const target = nodeById.get(edge.target)!;
                  const focused = Boolean(highlightedIds?.has(source.id) && highlightedIds?.has(target.id));
                  return <line key={`${edge.source}-${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} data-kind={edge.kind} data-focused={focused} />;
                })}
              </g>
              <g className="memory-graph__nodes">
                {graph.nodes.filter(visibleNode).map((node) => {
                  const focused = !highlightedIds || highlightedIds.has(node.id);
                  const selected = node.id === selectedId;
                  return <g
                    key={node.id}
                    data-memory-node={node.id}
                    data-layer={node.layer}
                    data-status={node.status || ""}
                    data-focused={focused}
                    data-selected={selected}
                    transform={`translate(${node.x} ${node.y})`}
                    onPointerEnter={() => setHoveredId(node.id)}
                    onPointerLeave={() => setHoveredId((current) => current === node.id ? null : current)}
                    onClick={(event) => { event.stopPropagation(); setSelectedId((current) => current === node.id ? null : node.id); }}
                  >
                    <circle className="memory-graph__node-hit" r={Math.max(12, node.radius * 2.5)} />
                    {selected ? <circle className="memory-graph__node-halo" r={node.radius * 2.2} /> : null}
                    <circle className="memory-graph__node-dot" r={node.radius} />
                  </g>;
                })}
              </g>
            </g>
          </svg>

          <div className="memory-graph__controls">
            <button type="button" title="放大" aria-label="放大图谱" onClick={() => zoom(1.2)}><ZoomIn /></button>
            <button type="button" title="缩小" aria-label="缩小图谱" onClick={() => zoom(0.8)}><ZoomOut /></button>
            <button type="button" title="适应画布" aria-label="适应画布" onClick={fit}><Maximize2 /></button>
            <span>{Math.round(view.scale * 100)}%</span>
          </div>

          <div className="memory-graph__guide">
            <div className="memory-graph__guide-levels" aria-label="图谱层级节点数">
              {(["L3", "L2", "L1"] as const).map((layer) => (
                <span key={layer}>
                  <i className={`is-${layer.toLowerCase()}`} aria-hidden="true" />
                  <strong>{layer}</strong>
                  <small>{layerCounts[layer]}</small>
                </span>
              ))}
            </div>
            <p>悬停节点可预览记忆。点击可锁定高亮，并追踪其向内（L1 → L2 → L3）或向外的引用关系。</p>
          </div>

          {activeNode ? <aside className="memory-graph__detail" data-layer={activeNode.layer}>
            <span className="memory-graph__detail-icon">{activeNode.layer === "L3" ? <Network /> : activeNode.layer === "L2" ? activeNode.status === "candidate" ? <Clock3 /> : <CheckCircle2 /> : <MessageSquareText />}</span>
            <span className="memory-graph__detail-body">
              <small>{layerDescription(activeNode)}</small>
              <strong>{activeNode.label}</strong>
              <p>{activeNode.detail}</p>
              <em>{activeNode.memoryIds.length ? `关联 ${activeNode.memoryIds.length} 条记忆事实` : ""}</em>
              {activeNode.timestamp ? <time>{formatDate(activeNode.timestamp)}</time> : null}
              {activeNode.memoryIds[0] && onOpenMemory ? <button type="button" onClick={() => onOpenMemory(activeNode.memoryIds[0])}>查看来源</button> : null}
            </span>
          </aside> : null}
        </>}
      </div>
      {graph.hiddenCount > 0 ? <p className="memory-graph__limit-note">为保持图谱流畅，另有 {graph.hiddenCount} 个较早节点未展开。</p> : null}
    </section>
  );
}
