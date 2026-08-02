import { ExternalLink, Globe2 } from "lucide-react";
import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/drawer";
import type { ChatWebSource } from "@/lib/web-sources";

function SourceMark({ source }: { source: ChatWebSource }) {
  const [imageFailed, setImageFailed] = useState(false);
  const label = (source.domain || source.provider || "W").replace(/^www\./i, "").slice(0, 1).toUpperCase();
  const faviconSrc = source.url
    ? `/api/web-favicon?source=${encodeURIComponent(source.url)}${source.faviconUrl ? `&icon=${encodeURIComponent(source.faviconUrl)}` : ""}`
    : "";
  return (
    <span className="lingxia-web-source-mark" aria-hidden="true">
      {faviconSrc && !imageFailed ? (
        <img src={faviconSrc} alt="" loading="lazy" onError={() => setImageFailed(true)} />
      ) : label || <Globe2 />}
    </span>
  );
}

export function WebSourceCard({ sources }: { sources: ChatWebSource[] }) {
  if (!sources.length) return null;
  const linkedCount = sources.filter((source) => Boolean(source.url)).length;

  return (
    <Sheet>
      <div className="lingxia-web-sources">
        <SheetTrigger asChild>
          <button type="button" className="lingxia-web-source-trigger" aria-label={`查看 ${sources.length} 条来源`}>
            <span className="lingxia-web-source-trigger__marks" aria-hidden="true">
              {sources.slice(0, 3).map((source) => <SourceMark key={source.id} source={source} />)}
            </span>
            <span>来源</span>
            <small>{sources.length}</small>
          </button>
        </SheetTrigger>
      </div>
      <SheetContent className="lingxia-web-source-sheet sm:max-w-[430px]">
        <SheetHeader className="lingxia-web-source-sheet__header">
          <SheetTitle>来源</SheetTitle>
          <SheetDescription>{linkedCount ? `${linkedCount} 条可访问链接` : "外部检索结果"}</SheetDescription>
        </SheetHeader>
        <div className="lingxia-web-source-list">
          {sources.map((source) => {
            const body = (
              <>
                <SourceMark source={source} />
                <span className="lingxia-web-source-item__body">
                  <strong>{source.title}</strong>
                  <small>
                    {source.domain}
                    {source.publishedAt ? ` · ${source.publishedAt}` : ""}
                    {!source.url ? " · 原始链接未提供" : ""}
                  </small>
                </span>
                {source.url ? <ExternalLink className="lingxia-web-source-item__external" aria-hidden="true" /> : null}
              </>
            );
            return source.url ? (
              <a
                key={source.id}
                className="lingxia-web-source-item"
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {body}
              </a>
            ) : (
              <div key={source.id} className="lingxia-web-source-item" data-disabled="true">
                {body}
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
