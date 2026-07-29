import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FileSearch, Loader2, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ChatKnowledgeSource } from "./ChatMessage";

type KnowledgeCitationPanelProps = {
  adoptId: string;
  source: ChatKnowledgeSource;
  onClose: () => void;
};

type CitationLocator = {
  page: number | null;
  position: string;
  headingPath: string[];
  matchedText: string;
};

type HighlightBox = {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
};

type PdfRuntime = typeof import("pdfjs-dist");
let pdfRuntimePromise: Promise<PdfRuntime> | null = null;

async function loadPdfRuntime(): Promise<PdfRuntime> {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([runtime, worker]) => {
      runtime.GlobalWorkerOptions.workerSrc = worker.default;
      return runtime;
    });
  }
  return pdfRuntimePromise;
}

export function normalizeCitationText(value: string): string {
  return String(value || "")
    .replace(/[\s\u00a0]+/g, "")
    .replace(/[“”‘’'"`]/g, "")
    .toLocaleLowerCase("zh-CN");
}

export function findCitationMatch(pageText: string, locatorText: string): { start: number; end: number } | null {
  const page = normalizeCitationText(pageText);
  const target = normalizeCitationText(locatorText);
  if (!page || !target) return null;
  const lengths = [180, 120, 80, 56, 40, 28, 18].filter((length) => length <= target.length);
  for (const length of lengths) {
    const step = Math.max(6, Math.floor(length / 3));
    for (let offset = 0; offset + length <= target.length; offset += step) {
      const snippet = target.slice(offset, offset + length);
      const start = page.indexOf(snippet);
      if (start >= 0) return { start, end: start + snippet.length };
    }
    const tail = target.slice(-length);
    const tailStart = page.indexOf(tail);
    if (tailStart >= 0) return { start: tailStart, end: tailStart + tail.length };
  }
  return null;
}

function extensionOf(name: string): string {
  return String(name || "").split(".").pop()?.toLowerCase() || "";
}

function contentUrl(source: ChatKnowledgeSource, adoptId: string): string {
  const query = new URLSearchParams({
    adoptId,
    knowledgeBaseId: source.knowledgeBaseId,
  });
  return `/api/knowledge/documents/${encodeURIComponent(source.documentId)}/content?${query.toString()}`;
}

function citationUrl(source: ChatKnowledgeSource, adoptId: string): string {
  const query = new URLSearchParams({
    adoptId,
    knowledgeBaseId: source.knowledgeBaseId,
    chunkId: source.chunkId,
    parentId: source.parentId,
  });
  return `/api/knowledge/documents/${encodeURIComponent(source.documentId)}/citation?${query.toString()}`;
}

function PdfCitationViewer({
  url,
  initialPage,
  locator,
}: {
  url: string;
  initialPage: number;
  locator: CitationLocator;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage));
  const [hostWidth, setHostWidth] = useState(420);
  const [boxes, setBoxes] = useState<HighlightBox[]>([]);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setPageNumber(Math.max(1, initialPage));
  }, [initialPage, url]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHostWidth(Math.max(280, host.clientWidth - 28));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let task: ReturnType<PdfRuntime["getDocument"]> | null = null;
    setLoading(true);
    setError("");
    setDocument(null);
    void loadPdfRuntime()
      .then((runtime) => {
        if (!active) return null;
        task = runtime.getDocument({ url, withCredentials: true });
        return task.promise;
      })
      .then((pdf) => {
        if (!active || !pdf) return;
        setDocument(pdf);
        setPageNumber((page) => Math.min(pdf.numPages, Math.max(1, page)));
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "PDF 加载失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!document || !canvas || hostWidth <= 0) return;
    let active = true;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    setLoading(true);
    setError("");
    setBoxes([]);
    void Promise.all([loadPdfRuntime(), document.getPage(pageNumber)])
      .then(async ([runtime, page]) => {
        if (!active) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2.2, Math.max(0.55, hostWidth / base.width));
        const viewport = page.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("浏览器无法创建 PDF 画布");
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setPageSize({ width: viewport.width, height: viewport.height });
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        const [, textContent] = await Promise.all([renderTask.promise, page.getTextContent()]);
        if (!active) return;
        const items = textContent.items.filter((item): item is typeof item & { str: string; transform: number[]; width: number; height: number } => (
          "str" in item && typeof item.str === "string" && Array.isArray(item.transform)
        ));
        let pageText = "";
        const spans: Array<{ item: (typeof items)[number]; start: number; end: number }> = [];
        for (const item of items) {
          const normalized = normalizeCitationText(item.str);
          const start = pageText.length;
          pageText += normalized;
          spans.push({ item, start, end: pageText.length });
        }
        const heading = locator.headingPath.at(-1) || locator.position;
        const match = findCitationMatch(pageText, locator.matchedText)
          || findCitationMatch(pageText, heading);
        if (!match) return;
        const highlighted = spans.filter((span) => span.end > match.start && span.start < match.end);
        setBoxes(highlighted.map(({ item }, index) => {
          const transform = runtime.Util.transform(viewport.transform, item.transform);
          const height = Math.max(7, Math.hypot(transform[2], transform[3]));
          return {
            key: `${index}:${transform[4]}:${transform[5]}`,
            left: transform[4] - 2,
            top: transform[5] - height - 1,
            width: Math.max(8, item.width * scale + 4),
            height: height + 3,
            rotate: Math.atan2(transform[1], transform[0]) * (180 / Math.PI),
          };
        }));
      })
      .catch((reason) => {
        if (active && reason?.name !== "RenderingCancelledException") {
          setError(reason instanceof Error ? reason.message : "PDF 页面渲染失败");
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [document, hostWidth, locator, pageNumber]);

  return (
    <div className="knowledge-citation-pdf" ref={hostRef}>
      <div className="knowledge-citation-pdf__toolbar">
        <button type="button" disabled={!document || pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))} aria-label="上一页"><ChevronLeft /></button>
        <span>PDF 第 {pageNumber} 页{document ? ` / ${document.numPages}` : ""}</span>
        <button type="button" disabled={!document || pageNumber >= document.numPages} onClick={() => setPageNumber((page) => Math.min(document?.numPages || page, page + 1))} aria-label="下一页"><ChevronRight /></button>
      </div>
      <div className="knowledge-citation-pdf__scroll">
        {loading ? <div className="knowledge-citation-panel__state"><Loader2 className="animate-spin" />正在定位原文...</div> : null}
        {error ? <div className="knowledge-citation-panel__state is-error">{error}</div> : null}
        <div className="knowledge-citation-pdf__page" style={{ width: pageSize.width || undefined, height: pageSize.height || undefined }}>
          <canvas ref={canvasRef} />
          <div className="knowledge-citation-pdf__highlights" aria-hidden="true">
            {boxes.map((box) => <i key={box.key} style={{ left: box.left, top: box.top, width: box.width, height: box.height, transform: `rotate(${box.rotate}deg)` }} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function KnowledgeCitationPanel({ adoptId, source, onClose }: KnowledgeCitationPanelProps) {
  const [locator, setLocator] = useState<CitationLocator | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const extension = extensionOf(source.documentName);
  const sourceUrl = useMemo(() => contentUrl(source, adoptId), [adoptId, source]);
  const isPdf = extension === "pdf";
  const isText = ["txt", "md", "csv", "json", "yaml", "yml"].includes(extension);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setLocator(null);
    setText("");
    const locate = fetch(citationUrl(source, adoptId), { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(payload?.error || "引用定位失败"));
        return payload.locator as CitationLocator;
      });
    const documentText = isText
      ? fetch(sourceUrl, { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error("原文读取失败");
          return response.text();
        })
      : Promise.resolve("");
    void Promise.all([locate, documentText])
      .then(([nextLocator, nextText]) => {
        setLocator(nextLocator);
        setText(nextText);
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "引用加载失败");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [adoptId, isText, source, sourceUrl]);

  return (
    <div className="knowledge-citation-panel">
      <header className="knowledge-citation-panel__header">
        <div><strong>知识来源</strong><span>[{source.index}] {source.documentName}</span></div>
        <div className="knowledge-citation-panel__actions">
          <a href={`${sourceUrl}&download=1`} aria-label="下载原文" title="下载"><Download /></a>
          <button type="button" onClick={onClose} aria-label="关闭知识来源" title="关闭"><X /></button>
        </div>
      </header>
      <div className="knowledge-citation-panel__meta">
        <FileSearch />
        <span>{source.headingPath?.length ? source.headingPath.join(" / ") : source.position}</span>
        {source.page ? <b>第 {source.page} 页</b> : null}
      </div>
      {loading ? <div className="knowledge-citation-panel__state"><Loader2 className="animate-spin" />正在读取引用...</div> : null}
      {error ? <div className="knowledge-citation-panel__state is-error">{error}</div> : null}
      {!loading && !error && locator && isPdf ? (
        <PdfCitationViewer url={sourceUrl} initialPage={locator.page || source.page || 1} locator={locator} />
      ) : null}
      {!loading && !error && locator && isText ? (
        <div className="knowledge-citation-panel__text">
          <blockquote>{locator.matchedText || "未找到定位片段"}</blockquote>
          <pre>{text}</pre>
        </div>
      ) : null}
      {!loading && !error && locator && !isPdf && !isText ? (
        <div className="knowledge-citation-panel__state">该格式暂不支持定位预览，可下载原文查看。</div>
      ) : null}
    </div>
  );
}
