/**
 * SlidePreviewModal — full-screen PPT preview modal
 *
 * 布局：
 *   顶部导航栏  文档标题 + 图标 | 下载 / 播放 / 关闭
 *   左侧边栏    slide 缩略图列表 + 页码 + 选中态高亮（红色）
 *   中间主区    当前幻灯片大图预览，深色背景
 *
 * 实现：
 *   - fetch preview.html 后用 DOMParser 提取每个 .slide outerHTML 和共享 <style>
 *   - 缩略图和主预览都是 iframe srcDoc（sandbox，只渲染单页）
 *   - 左侧缩略图通过 CSS transform: scale(0.2) 压缩
 */
import { useState, useEffect, useRef, useMemo } from "react";
import { X, Download, Play, FileText, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

interface SlideData {
  html: string;
  title: string;
}

interface SlidePreviewModalProps {
  open: boolean;
  onClose: () => void;
  previewUrl: string;
  downloadUrl: string;
  fileName: string;
}

export function SlidePreviewModal({ open, onClose, previewUrl, downloadUrl, fileName }: SlidePreviewModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slides, setSlides] = useState<SlideData[]>([]);
  const [docTitle, setDocTitle] = useState<string>("");
  const [docStyles, setDocStyles] = useState<string>("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playTimerRef = useRef<number | null>(null);

  // ── 载入 HTML 并解析 ──
  useEffect(() => {
    if (!open || !previewUrl) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSlides([]);
    setCurrentIndex(0);

    fetch(previewUrl, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((html) => {
        if (cancelled) return;
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");
          const title = doc.querySelector("title")?.textContent?.trim() || fileName.replace(/-preview\.html$/i, "").replace(/\.pptx$/i, "");
          const styleTag = doc.querySelector("style");
          const styles = styleTag?.textContent || "";
          const slideEls = Array.from(doc.querySelectorAll(".slide"));
          const parsed: SlideData[] = slideEls.map((el, i) => {
            const h1 = el.querySelector("h1")?.textContent?.trim();
            const h2 = el.querySelector("h2")?.textContent?.trim();
            const coverTitle = el.querySelector(".cover h1")?.textContent?.trim();
            const titleText = coverTitle || h1 || h2 || `第 ${i + 1} 页`;
            return { html: (el as HTMLElement).outerHTML, title: titleText.slice(0, 40) };
          });
          setDocTitle(title);
          setDocStyles(styles);
          setSlides(parsed);
          setLoading(false);
        } catch (e: any) {
          setError("解析 PPT 预览失败：" + (e?.message || "unknown"));
          setLoading(false);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError("加载 PPT 预览失败：" + (e?.message || "unknown"));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [open, previewUrl, fileName]);

  // ── ESC 关闭 + 左右键切换 ──
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setCurrentIndex((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight") setCurrentIndex((i) => Math.min(slides.length - 1, i + 1));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, slides.length]);

  // ── 播放模式（2s/页 自动翻）──
  useEffect(() => {
    if (playTimerRef.current != null) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    if (isPlaying && slides.length > 0) {
      playTimerRef.current = window.setInterval(() => {
        setCurrentIndex((i) => {
          if (i >= slides.length - 1) {
            setIsPlaying(false);
            return i;
          }
          return i + 1;
        });
      }, 2500);
    }
    return () => {
      if (playTimerRef.current != null) {
        window.clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, slides.length]);

  // ── 构造单页 srcDoc（嵌入共享 style + body 背景色配合 PPT 主题）──
  const srcDocFor = useMemo(() => {
    return (slideHtml: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${docStyles}
html,body{background:#fff !important;padding:0 !important;margin:0 !important;overflow:hidden !important;}
.slide-frame{width:100vw;aspect-ratio:16/9;container-type:inline-size;overflow:hidden;}
.slide-frame>.slide{width:1280px !important;height:720px !important;margin:0 !important;max-width:none !important;border-radius:0 !important;box-shadow:none !important;transform:scale(calc(100cqw / 1280));transform-origin:top left;}
body>.slide{zoom:0.75;margin:0 !important;border-radius:0 !important;box-shadow:none !important;}</style></head><body><div class="slide-frame">${slideHtml}</div></body></html>`;
  }, [docStyles]);

  if (!open) return null;

  const currentSlide = slides[currentIndex];

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col"
      style={{ background: "rgba(10,10,10,0.95)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* ── 顶部导航栏 ── */}
      <div className="h-14 shrink-0 flex items-center justify-between px-5 border-b" style={{ background: "#1a1a1a", borderColor: "#2a2a2a" }}>
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(199,0,11,0.15)" }}>
            <FileText className="w-4 h-4" style={{ color: "#c7000b" }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate" style={{ color: "#f5f5f5" }}>{docTitle || fileName}</div>
            <div className="text-[10px]" style={{ color: "#888" }}>
              {slides.length > 0 ? `共 ${slides.length} 页 · 当前第 ${currentIndex + 1} 页` : (loading ? "加载中..." : error || "-")}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            disabled={slides.length === 0}
            title={isPlaying ? "暂停播放" : "自动播放（2.5s/页）"}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30"
            style={{
              background: isPlaying ? "rgba(199,0,11,0.3)" : "rgba(255,255,255,0.08)",
              color: isPlaying ? "#ff6b6b" : "#ccc",
              border: "1px solid rgba(255,255,255,0.1)",
            }}
          >
            <Play className="w-3.5 h-3.5" />
          </button>
          <a
            href={downloadUrl}
            download={fileName}
            title="下载 PPTX"
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
            style={{
              background: "rgba(255,255,255,0.08)",
              color: "#ccc",
              border: "1px solid rgba(255,255,255,0.1)",
              textDecoration: "none",
            }}
          >
            <Download className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={onClose}
            title="关闭 (Esc)"
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
            style={{
              background: "rgba(255,255,255,0.08)",
              color: "#ccc",
              border: "1px solid rgba(255,255,255,0.1)",
              marginLeft: 4,
            }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧缩略图边栏 */}
        <div
          className="w-56 shrink-0 overflow-y-auto py-3 px-2.5 space-y-2"
          style={{ background: "#141414", borderRight: "1px solid #2a2a2a" }}
        >
          {loading && <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 animate-spin" style={{ color: "#666" }} /></div>}
          {error && <div className="text-xs text-red-400 text-center py-4">{error}</div>}
          {slides.map((slide, i) => {
            const isActive = i === currentIndex;
            return (
              <div
                key={i}
                onClick={() => setCurrentIndex(i)}
                className="cursor-pointer transition-all group"
                style={{
                  padding: 6,
                  borderRadius: 8,
                  background: isActive ? "rgba(199,0,11,0.12)" : "transparent",
                  border: isActive ? "1px solid rgba(199,0,11,0.5)" : "1px solid transparent",
                }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-mono" style={{ color: isActive ? "#ff6b6b" : "#666" }}>
                    第 {i + 1} 页
                  </span>
                  {isActive && <div className="w-1.5 h-1.5 rounded-full" style={{ background: "#c7000b" }} />}
                </div>
                {/* 缩略图 iframe：scale 0.2 压缩 */}
                <div
                  className="relative overflow-hidden rounded"
                  style={{
                    aspectRatio: "16 / 9",
                    background: "#fff",
                    border: isActive ? "2px solid #c7000b" : "1px solid #333",
                    pointerEvents: "none",
                  }}
                >
                  <iframe
                    title={`slide-thumb-${i}`}
                    srcDoc={srcDocFor(slide.html)}
                    sandbox=""
                    loading="lazy"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "500%",
                      height: "500%",
                      border: "none",
                      transform: "scale(0.2)",
                      transformOrigin: "top left",
                      pointerEvents: "none",
                    }}
                  />
                </div>
                <div
                  className="text-[11px] mt-1.5 truncate"
                  style={{ color: isActive ? "#f5f5f5" : "#888" }}
                >
                  {slide.title}
                </div>
              </div>
            );
          })}
          {!loading && !error && slides.length === 0 && (
            <div className="text-xs text-gray-500 text-center py-6">无 slide 可显示</div>
          )}
        </div>

        {/* 主预览区 */}
        <div
          className="flex-1 flex items-center justify-center p-8 relative"
          style={{ background: "#0a0a0a" }}
        >
          {loading && (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: "#c7000b" }} />
              <div className="text-sm" style={{ color: "#888" }}>正在加载预览…</div>
            </div>
          )}
          {error && <div className="text-sm text-red-400">{error}</div>}
          {currentSlide && !loading && (
            <>
              <div
                className="relative rounded-lg overflow-hidden shadow-2xl"
                style={{
                  aspectRatio: "16 / 9",
                  width: "100%",
                  maxWidth: "min(100%, calc((100vh - 180px) * 16 / 9))",
                  background: "#fff",
                  boxShadow: "0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)",
                }}
              >
                <iframe
                  key={currentIndex}
                  title={`slide-main-${currentIndex}`}
                  srcDoc={srcDocFor(currentSlide.html)}
                  sandbox=""
                  style={{ width: "100%", height: "100%", border: "none", display: "block" }}
                />
              </div>

              {/* 左右翻页按钮（浮在主区） */}
              {slides.length > 1 && (
                <>
                  <button
                    onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
                    disabled={currentIndex === 0}
                    className="absolute left-4 w-10 h-10 rounded-full flex items-center justify-center transition-all disabled:opacity-20"
                    style={{
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.15)",
                      color: "#fff",
                      top: "50%",
                      transform: "translateY(-50%)",
                    }}
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => setCurrentIndex(Math.min(slides.length - 1, currentIndex + 1))}
                    disabled={currentIndex >= slides.length - 1}
                    className="absolute right-4 w-10 h-10 rounded-full flex items-center justify-center transition-all disabled:opacity-20"
                    style={{
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.15)",
                      color: "#fff",
                      top: "50%",
                      transform: "translateY(-50%)",
                    }}
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </>
              )}

              {/* 底部页码指示器 */}
              <div
                className="absolute bottom-6 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-mono"
                style={{
                  background: "rgba(0,0,0,0.6)",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.1)",
                  backdropFilter: "blur(8px)",
                }}
              >
                {currentIndex + 1} / {slides.length}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
