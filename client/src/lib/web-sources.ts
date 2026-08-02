export type ChatWebSource = {
  id: string;
  title: string;
  url?: string;
  domain: string;
  provider: string;
  publishedAt?: string;
  faviconUrl?: string;
};

type SourceToolCall = {
  name?: string;
  result?: string;
  status?: string;
};

type SourceCandidate = {
  title?: unknown;
  url?: unknown;
  date?: unknown;
  favicon?: unknown;
};

const SOURCE_TOOL_RE = /(?:fetch_webpage|web_fetch|web_search|browser|search|news|announcement|financial_docs)/i;
const PRIVATE_IPV4_RE = /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function textValue(value: unknown, max = 240): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function publicWebUrl(value: unknown): string {
  const raw = textValue(value, 4096).replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (parsed.username || parsed.password) return "";
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0") return "";
    if (PRIVATE_IPV4_RE.test(hostname)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function sourceDomain(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function sourceProvider(toolName: string): string {
  if (/wind/i.test(toolName)) return "Wind金融终端";
  if (/(?:fetch_webpage|web_fetch|browser)/i.test(toolName)) return "网页";
  if (/web_search|search/i.test(toolName)) return "网页搜索";
  return "外部工具";
}

function sourceToolPriority(toolName: string): number {
  if (/(?:fetch_webpage|web_fetch|web_search|browser)/i.test(toolName)) return 0;
  if (/(?:financial_news|news|search)/i.test(toolName)) return 1;
  if (/announcement/i.test(toolName)) return 2;
  return 3;
}

function candidateFromObject(value: Record<string, unknown>): SourceCandidate | null {
  const title = value.title ?? value.headline ?? value.name;
  const url = value.url ?? value.link ?? value.source_url ?? value.sourceUrl ?? value.web_url ?? value.webUrl;
  const date = value.date ?? value.published_at ?? value.publishedAt ?? value.publish_time ?? value.publishTime;
  const favicon = value.favicon ?? value.favicon_url ?? value.faviconUrl ?? value.icon ?? value.icon_url ?? value.iconUrl;
  return textValue(title) || publicWebUrl(url) ? { title, url, date, favicon } : null;
}

function collectStructuredCandidates(
  value: unknown,
  candidates: SourceCandidate[],
  nestedStrings: string[],
  depth = 0,
): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    if (/[{[]/.test(value) && value.length <= 250_000) nestedStrings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) collectStructuredCandidates(item, candidates, nestedStrings, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const candidate = candidateFromObject(record);
  if (candidate) candidates.push(candidate);
  for (const nested of Object.values(record)) {
    collectStructuredCandidates(nested, candidates, nestedStrings, depth + 1);
  }
}

function balancedJsonObject(raw: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return "";
}

function parseEmbeddedJson(raw: string): unknown[] {
  const parsed: unknown[] = [];
  const starts = Array.from(raw.matchAll(/\{(?=")/g), (match) => match.index).filter((index): index is number => index != null);
  for (const start of starts.slice(0, 12)) {
    const candidate = balancedJsonObject(raw, start);
    if (!candidate) continue;
    try {
      parsed.push(JSON.parse(candidate));
    } catch {}
  }
  return parsed;
}

function structuredCandidates(raw: string): SourceCandidate[] {
  const candidates: SourceCandidate[] = [];
  const queue = [raw];
  const seen = new Set<string>();
  for (let cursor = 0; cursor < queue.length && cursor < 30; cursor += 1) {
    const current = queue[cursor];
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const values: unknown[] = [];
    try {
      values.push(JSON.parse(current));
    } catch {}
    values.push(...parseEmbeddedJson(current));
    for (const value of values) {
      const nestedStrings: string[] = [];
      collectStructuredCandidates(value, candidates, nestedStrings);
      for (const nested of nestedStrings) {
        if (!seen.has(nested)) queue.push(nested);
      }
    }
  }
  return candidates;
}

function webpageCandidate(raw: string): SourceCandidate | null {
  const url = raw.match(/(?:^|\n)URL:\s*(https?:\/\/[^\s<>"']+)/i)?.[1] || "";
  if (!publicWebUrl(url)) return null;
  const title = raw.match(/(?:^|\n)Title:\s*([^\n]+)/i)?.[1] || "";
  const empty = /(?:^|\n)Content:\s*\[empty\]\s*$/i.test(raw);
  if (empty && !title.trim()) return null;
  return { title, url };
}

export function extractChatWebSources(toolCalls: SourceToolCall[], limit = 8): ChatWebSource[] {
  const linkedSources = new Map<string, ChatWebSource>();
  let unlinkedFallback: Map<string, ChatWebSource> | null = null;
  const orderedTools = (toolCalls || [])
    .map((tool, index) => ({ tool, index }))
    .sort((left, right) => (
      sourceToolPriority(textValue(left.tool?.name, 160)) - sourceToolPriority(textValue(right.tool?.name, 160))
      || left.index - right.index
    ));
  for (const { tool } of orderedTools) {
    const toolName = textValue(tool?.name, 160);
    const result = typeof tool?.result === "string" ? tool.result : "";
    if (!toolName || !result || tool.status === "running" || tool.status === "error") continue;
    const provider = sourceProvider(toolName);
    const candidates = structuredCandidates(result);
    const webpage = webpageCandidate(result);
    if (webpage) candidates.unshift(webpage);
    const toolUnlinked = new Map<string, ChatWebSource>();
    for (const candidate of candidates) {
      const url = publicWebUrl(candidate.url);
      const domain = sourceDomain(url);
      const title = textValue(candidate.title) || domain;
      if (!title) continue;
      if (!url && !SOURCE_TOOL_RE.test(toolName)) continue;
      const key = url ? `url:${url}` : `title:${provider}:${title.toLocaleLowerCase("zh-CN")}`;
      const source = {
        id: key,
        title,
        ...(url ? { url } : {}),
        domain: domain || provider,
        provider,
        ...(textValue(candidate.date, 40) ? { publishedAt: textValue(candidate.date, 40) } : {}),
        ...(publicWebUrl(candidate.favicon) ? { faviconUrl: publicWebUrl(candidate.favicon) } : {}),
      } satisfies ChatWebSource;
      if (url) {
        if (!linkedSources.has(key)) linkedSources.set(key, source);
      } else if (!toolUnlinked.has(key)) {
        toolUnlinked.set(key, source);
      }
    }
    if (!unlinkedFallback && toolUnlinked.size > 0) unlinkedFallback = toolUnlinked;
  }
  return [
    ...Array.from(linkedSources.values()),
    ...Array.from(unlinkedFallback?.values() || []),
  ].slice(0, limit);
}
