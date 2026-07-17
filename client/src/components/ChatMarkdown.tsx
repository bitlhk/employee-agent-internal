import { memo, useLayoutEffect, useRef, useState, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { stabilizeStreamingMarkdown } from "@/lib/streaming-markdown";

function childrenToString(children: any): string {
  if (children == null) return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenToString).join("");
  if (isValidElement(children)) {
    const el = children as any;
    return childrenToString(el.props?.children ?? "");
  }
  return String(children);
}

function slugify(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^\w\u4e00-\u9fa5 -]/g, "")
    .replace(/\s+/g, "-");
}

function extractLang(className?: string): string {
  if (!className) return "";
  const m = className.match(/language-(\w+)/);
  return m ? m[1] : "";
}

function normalizeSafeHref(href?: string): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("#")) return href;
  try {
    const parsed = new URL(href, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return href;
    }
  } catch {}
  return undefined;
}

function normalizeSafeImageSrc(src?: string): string | undefined {
  if (!src) return undefined;
  try {
    const parsed = new URL(src, window.location.origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (!/\.(png|jpe?g|gif|webp|bmp|ico|avif)(?:$|[?#])/i.test(parsed.pathname)) {
      return undefined;
    }
    return src;
  } catch {}
  return undefined;
}

function FencedCodeBlock({ code, className }: { code: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const lang = extractLang(className) || "text";
  const isHtml = lang === "html" || lang === "htm";
  const safeHtmlPreview = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">${code}`;

  const onCopy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };

  return (
    <div className="lingxia-codeblock">
      <div className="lingxia-codeblock__header">
        <span className="lingxia-codeblock__lang">{lang}</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {isHtml && (
            <>
              <button className="lingxia-codeblock__copy" onClick={() => setPreviewing(!previewing)} type="button" title={previewing ? "关闭预览" : "预览"}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                {previewing ? "关闭" : "预览"}
              </button>
            </>
          )}
          <button className="lingxia-codeblock__copy" onClick={onCopy} type="button">
            {copied ? (
              <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Copied!</>
            ) : (
              <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</>
            )}
          </button>
        </div>
      </div>
      {previewing && isHtml && (
        <div style={{ background: "#fff", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
          <iframe
            srcDoc={safeHtmlPreview}
            sandbox=""
            referrerPolicy="no-referrer"
            style={{ width: "100%", height: 480, border: "none", display: "block" }}
            title="HTML Preview"
          />
        </div>
      )}
      {!previewing && <pre className="lingxia-codeblock__body"><code className={className}>{code}</code></pre>}
    </div>
  );
}

type Props = { content: string; phase?: "streaming" | "final" };

function ChatMarkdownInner({ content, phase = "final" }: Props) {
  const renderStartRef = useRef(0);
  if (typeof performance !== "undefined") renderStartRef.current = performance.now();
  const markdownSource = phase === "streaming" ? stabilizeStreamingMarkdown(content) : content;
  useLayoutEffect(() => {
    try {
      if (localStorage.getItem("ea_markdown_perf") !== "1") return;
      const elapsed = performance.now() - renderStartRef.current;
      console.debug("[EA_MD_PERF]", {
        phase,
        chars: content.length,
        ms: Number(elapsed.toFixed(2)),
      });
    } catch {}
  }, [content, phase]);
  return (
    <div className="lingxia-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={phase === "streaming" ? [] : [rehypeHighlight]}
        components={{
          code({ inline, className, children, ...props }: any) {
            if (inline) {
              return <code className="lingxia-inline-code" {...props}>{children}</code>;
            }
            const text = childrenToString(children).replace(/\n$/, "");
            // text/plain/无语言标记仍然是块级代码，不能退化成 inline，否则换行和列表会乱。
            const lang = String(className || "").replace("language-", "").toLowerCase();
            if (!lang || lang === "text" || lang === "plain" || lang === "txt") {
              return (
                <pre className="lingxia-plain-code">
                  <code {...props}>{text}</code>
                </pre>
              );
            }
            return <FencedCodeBlock code={text} className={className} />;
          },
          h1: ({ children }) => <h1 className="lingxia-md-h1">{children}</h1>,
          h2: ({ children }) => {
            const text = childrenToString(children);
            const id = slugify(text);
            return (
              <h2 id={id} className="lingxia-md-h2 group">
                <a href={`#${id}`} className="mr-1 opacity-0 group-hover:opacity-100 transition-opacity no-underline"
                  style={{ color: "rgba(255,255,255,0.28)", textDecoration: "none" }} aria-label={`跳转到 ${text}`}>#</a>
                {children}
              </h2>
            );
          },
          h3: ({ children }) => {
            const text = childrenToString(children);
            const id = slugify(text);
            return (
              <h3 id={id} className="lingxia-md-h3 group">
                <a href={`#${id}`} className="mr-1 opacity-0 group-hover:opacity-100 transition-opacity no-underline"
                  style={{ color: "rgba(255,255,255,0.24)", textDecoration: "none" }} aria-label={`跳转到 ${text}`}>#</a>
                {children}
              </h3>
            );
          },
          h4: ({ children }) => <h4 className="lingxia-md-h4">{children}</h4>,
          p:  ({ children }) => <p className="lingxia-md-p">{children}</p>,
          ul: ({ children }) => <ul className="lingxia-md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="lingxia-md-ol">{children}</ol>,
          li: ({ children }) => <li className="lingxia-md-li">{children}</li>,
          blockquote: ({ children }) => <blockquote className="lingxia-md-blockquote">{children}</blockquote>,
          table: ({ children }) => (
            <div className="lingxia-md-table-wrap"><table className="lingxia-md-table">{children}</table></div>
          ),
          th: ({ children, align }) => (
            <th className="lingxia-md-th" style={align ? { textAlign: align as any } : undefined}>
              {children}
            </th>
          ),
          td: ({ children, align }) => (
            <td className="lingxia-md-td" style={align ? { textAlign: align as any } : undefined}>
              {children}
            </td>
          ),
          a:  ({ href, children }) => {
            const safeHref = normalizeSafeHref(href);
            if (!safeHref) {
              return <span className="lingxia-md-link" title="链接协议不受支持">{children}</span>;
            }
            const isHash = safeHref.startsWith("#");
            return (
              <a
                href={safeHref}
                target={isHash ? undefined : "_blank"}
                rel={isHash ? undefined : "noopener noreferrer"}
                className="lingxia-md-link"
              >
                {children}
              </a>
            );
          },
          img: ({ src, alt, title }) => {
            const safeSrc = normalizeSafeImageSrc(src);
            const fallbackText = alt || src || "图片";
            if (!safeSrc) {
              return <span className="lingxia-md-link" title="图片地址不受支持">{fallbackText}</span>;
            }
            return (
              <img
                src={safeSrc}
                alt={alt || ""}
                title={title}
                loading="lazy"
                referrerPolicy="no-referrer"
                className="lingxia-md-image"
              />
            );
          },
          hr:     () => <hr className="lingxia-md-hr" />,
          strong: ({ children }) => <strong className="lingxia-md-strong">{children}</strong>,
          em:     ({ children }) => <em className="lingxia-md-em">{children}</em>,
        }}
      >
        {markdownSource}
      </ReactMarkdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownInner, (prev, next) => prev.content === next.content && prev.phase === next.phase);
