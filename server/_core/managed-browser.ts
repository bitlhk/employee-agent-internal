import express from "express";
import { lookup } from "dns/promises";
import { createHash } from "crypto";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { BlockList, isIP } from "net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "zlib";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
import { isAuthorizedInternalRequest, isPrivateUrl } from "./helpers";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TEXT_LIMIT = 80_000;
const MAX_REDIRECTS = 5;

const PRIVATE_IPV4_BLOCK_LIST = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE_IPV4_BLOCK_LIST.addSubnet(network, prefix, "ipv4");
}

type ManagedBrowserAction = "open" | "extract" | "snapshot" | "screenshot";

type ManagedBrowserInput = {
  action?: ManagedBrowserAction;
  url?: string;
  mode?: "auto" | "article" | "text";
  maxChars?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function internalToken() {
  return String(process.env.MANAGED_BROWSER_INTERNAL_TOKEN || process.env.WEALTH_ASSISTANT_INTERNAL_TOKEN || "").trim();
}

function authorizeInternalRequest(req: express.Request) {
  const token = internalToken();
  return isAuthorizedInternalRequest(req, token || undefined);
}

function readAction(value: unknown): ManagedBrowserAction {
  if (value === "open" || value === "snapshot" || value === "screenshot") return value;
  return "extract";
}

function readMaxChars(value: unknown) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_TEXT_LIMIT;
  return Math.max(2_000, Math.min(DEFAULT_TEXT_LIMIT, n));
}

function normalizeUrl(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("url required");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http/https URLs are supported");
  }
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  if (isPrivateUrl(url.toString())) {
    throw new Error("private or local URLs are not allowed");
  }
  return url;
}

export function isPrivateManagedBrowserIp(rawHost: string) {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  const mappedV4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedV4) return isPrivateManagedBrowserIp(mappedV4);

  // BlockList normalizes all IPv4-mapped IPv6 forms, including hexadecimal
  // tails such as ::ffff:7f00:1, before checking the IPv4 private ranges.
  if (isIP(host) === 6 && PRIVATE_IPV4_BLOCK_LIST.check(host, "ipv6")) return true;

  if (isIP(host) === 4) {
    const [a, b, c] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }

  if (isIP(host) === 6) {
    return host === "::" || host === "::1"
      || host.startsWith("fc") || host.startsWith("fd")
      || /^fe[89ab]/.test(host)
      || host.startsWith("ff")
      || host.startsWith("2001:db8:");
  }
  return true;
}

async function resolvePublicHostname(url: URL) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isPrivateManagedBrowserIp(hostname)) throw new Error("private IP URLs are not allowed");
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error("hostname did not resolve");
  if (records.some((record) => isPrivateManagedBrowserIp(record.address))) {
    throw new Error("hostname resolves to a private IP");
  }
  return records.find((record) => record.family === 4) || records[0];
}

function stripHtml(value: string) {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    });
}

function pickTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeEntities(String(match?.[1] || "").replace(/\s+/g, " ").trim());
}

function pickMetaDescription(html: string) {
  const match = html.match(/<meta\s+[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i);
  return decodeEntities(String(match?.[1] || "").replace(/\s+/g, " ").trim());
}

function extractLinks(html: string, baseUrl: string) {
  const links: Array<{ text: string; href: string }> = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && links.length < 40) {
    const text = htmlToText(match[2]).slice(0, 120);
    if (!text) continue;
    try {
      const href = new URL(match[1], baseUrl).toString();
      if (href.startsWith("http://") || href.startsWith("https://")) links.push({ text, href });
    } catch {}
  }
  return links;
}

function extractHeadings(html: string) {
  const headings: string[] = [];
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && headings.length < 30) {
    const text = htmlToText(match[2]).slice(0, 160);
    if (text) headings.push(text);
  }
  return headings;
}

function htmlToText(html: string) {
  const withBreaks = stripHtml(html)
    .replace(/<\/(?:p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withBreaks)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToMarkdown(html: string, baseUrl: string, maxChars: number) {
  let text = stripHtml(html);
  text = text
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_m, body) => `\n# ${htmlToText(body)}\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_m, body) => `\n## ${htmlToText(body)}\n`)
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_m, body) => `\n### ${htmlToText(body)}\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body) => `\n\n\`\`\`\n${htmlToText(body)}\n\`\`\`\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => `\n- ${htmlToText(body)}`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, body) => {
      const label = htmlToText(body).slice(0, 160);
      if (!label) return "";
      try {
        return `[${label}](${new URL(href, baseUrl).toString()})`;
      } catch {
        return label;
      }
    })
    .replace(/<\/(?:p|div|section|article|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const markdown = decodeEntities(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return markdown.length > maxChars ? `${markdown.slice(0, maxChars).trimEnd()}\n\n[内容已截断]` : markdown;
}

function looksLikeLoginPage(title: string, text: string, finalUrl: string) {
  const sample = `${title}\n${finalUrl}\n${text.slice(0, 4000)}`.toLowerCase();
  return /login|signin|sign-in|passport|sso|auth|登录|登陆|扫码|验证码|身份验证/.test(sample);
}

function authRequiredResult(base: Record<string, unknown>, action: ManagedBrowserAction) {
  return {
    ...base,
    ok: false,
    errorCode: "AUTH_REQUIRED",
    error: "The page redirects to a login or identity verification page. Managed browser lite can only read public pages without user session cookies.",
    needsUserSession: true,
    markdown: action === "extract" ? "" : undefined,
    textPreview: action === "open" ? "" : undefined,
    visibleText: action === "snapshot" ? "" : undefined,
    links: [],
    headings: [],
  };
}

function decodeResponseBody(body: Buffer, encoding: string): Buffer {
  const options = { maxOutputLength: DEFAULT_MAX_BYTES };
  if (encoding === "gzip") return gunzipSync(body, options);
  if (encoding === "deflate") return inflateSync(body, options);
  if (encoding === "br") return brotliDecompressSync(body, options);
  return body;
}

async function requestPinned(url: URL, timeoutMs: number) {
  const resolved = await resolvePublicHostname(url);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      headers: {
        "user-agent": "EmployeeAgentManagedBrowser/0.1",
        "accept": "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
        "accept-encoding": "gzip, deflate, br",
      },
      lookup: (_hostname, _options, callback) => {
        const options = typeof _options === "object" ? _options : {};
        if (options.all) {
          (callback as any)(null, [{ address: resolved.address, family: resolved.family }]);
        } else {
          (callback as any)(null, resolved.address, resolved.family);
        }
      },
    }, (response) => {
      const contentLength = Number(response.headers["content-length"] || 0);
      if (contentLength > DEFAULT_MAX_BYTES) {
        response.resume();
        reject(new Error(`response too large (${contentLength} bytes)`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > DEFAULT_MAX_BYTES) {
          req.destroy(new Error(`response too large (${bytes} bytes)`));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("managed browser request timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function fetchManagedBrowserHtml(initialUrl: URL, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let url = initialUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("managed browser request timed out");
    const response = await requestPinned(url, remaining);
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      if (redirects === MAX_REDIRECTS) throw new Error("too many redirects");
      url = normalizeUrl(new URL(Array.isArray(location) ? location[0] : location, url).toString());
      continue;
    }

    const decoded = decodeResponseBody(response.body, String(response.headers["content-encoding"] || "").toLowerCase());
    if (decoded.byteLength > DEFAULT_MAX_BYTES) throw new Error(`response too large (${decoded.byteLength} bytes)`);
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      finalUrl: url.toString(),
      contentType: String(response.headers["content-type"] || ""),
      bytes: decoded.byteLength,
      html: decoded.toString("utf8"),
    };
  }
  throw new Error("too many redirects");
}

async function runManagedBrowserTool(input: ManagedBrowserInput) {
  const action = readAction(input.action);
  if (action === "screenshot") {
    return {
      ok: false,
      action,
      error: "managed_browser_screenshot is not configured yet. Install a browser runtime before enabling screenshots.",
      needsBrowserRuntime: true,
    };
  }

  const url = normalizeUrl(input.url);
  const maxChars = readMaxChars(input.maxChars);
  const fetched = await fetchManagedBrowserHtml(url, DEFAULT_TIMEOUT_MS);
  const title = pickTitle(fetched.html);
  const description = pickMetaDescription(fetched.html);
  const text = htmlToText(fetched.html);
  const possibleLogin = looksLikeLoginPage(title, text, fetched.finalUrl);

  const base = {
    ok: fetched.ok,
    action,
    url: url.toString(),
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    title,
    description,
    contentType: fetched.contentType,
    bytes: fetched.bytes,
    possibleLogin,
    source: "managed-browser-lite",
  };

  if (possibleLogin) {
    return authRequiredResult(base, action);
  }

  if (action === "open") {
    return {
      ...base,
      textPreview: text.slice(0, Math.min(maxChars, 12_000)),
      links: extractLinks(fetched.html, fetched.finalUrl).slice(0, 12),
    };
  }

  if (action === "snapshot") {
    return {
      ...base,
      headings: extractHeadings(fetched.html),
      links: extractLinks(fetched.html, fetched.finalUrl),
      visibleText: text.slice(0, maxChars),
    };
  }

  return {
    ...base,
    markdown: htmlToMarkdown(fetched.html, fetched.finalUrl, maxChars),
    headings: extractHeadings(fetched.html).slice(0, 20),
  };
}

export function registerManagedBrowserRoutes(app: express.Express) {
  app.post("/api/internal/managed-browser/tool", async (req, res) => {
    const startedAt = Date.now();
    if (!authorizeInternalRequest(req)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const input = (body.input && typeof body.input === "object" ? body.input : body) as ManagedBrowserInput;
    const action = readAction(input.action);
    const url = String(input.url || "").trim();
    const trustedContext = asRecord(body.trustedContext);
    const agentId = String(body.agentId || trustedContext.agentId || "").trim();
    const sessionKey = String(body.sessionKey || trustedContext.sessionKey || "").trim();
    const urlHash = url ? sha256(url) : "";

    try {
      const result = await runManagedBrowserTool(input);
      const resultRecord = asRecord(result);
      await recordAuditBestEffort({
        action: "tool.managed_browser.completed",
        result: result.ok === false ? "failed" : "success",
        severity: result.ok === false ? "medium" : "info",
        actorType: "system",
        targetType: "tool",
        targetId: `managed_browser_${action}`,
        targetName: `managed_browser_${action}`,
        resourceType: "agent",
        resourceId: agentId || null,
        runtimeType: "openclaw",
        runtimeAgentId: agentId || null,
        detailType: "managed_browser_tool",
        toolName: `managed_browser_${action}`,
        metadata: {
          urlHash,
          host: url ? new URL(url).hostname : null,
          sessionKey: sessionKey || null,
          status: resultRecord.status ?? null,
          possibleLogin: Boolean(resultRecord.possibleLogin),
          durationMs: Date.now() - startedAt,
        },
        ...auditRequest(req),
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordAuditBestEffort({
        action: "tool.managed_browser.failed",
        result: "failed",
        severity: "medium",
        actorType: "system",
        targetType: "tool",
        targetId: `managed_browser_${action}`,
        targetName: `managed_browser_${action}`,
        resourceType: "agent",
        resourceId: agentId || null,
        runtimeType: "openclaw",
        runtimeAgentId: agentId || null,
        detailType: "managed_browser_tool",
        toolName: `managed_browser_${action}`,
        errorCode: "MANAGED_BROWSER_ERROR",
        metadata: {
          urlHash,
          host: (() => { try { return url ? new URL(url).hostname : null; } catch { return null; } })(),
          error: message,
          durationMs: Date.now() - startedAt,
        },
        ...auditRequest(req),
      });
      res.status(400).json({ ok: false, action, error: message });
    }
  });
}
