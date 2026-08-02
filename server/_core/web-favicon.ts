import express from "express";
import type { IncomingMessage } from "http";
import { safeAgentRequest } from "./safe-agent-http";
import { sdk } from "./sdk";

const MAX_FAVICON_BYTES = 128 * 1024;
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;

type FaviconCacheEntry = {
  expiresAt: number;
  body?: Buffer;
  contentType?: string;
};

const faviconCache = new Map<string, FaviconCacheEntry>();

function publicHttpUrl(raw: unknown): URL | null {
  try {
    const parsed = new URL(String(raw || "").trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function resolveFaviconCandidates(sourceRaw: unknown, iconRaw?: unknown): string[] {
  const source = publicHttpUrl(sourceRaw);
  if (!source) return [];
  const candidates: string[] = [];
  const icon = publicHttpUrl(iconRaw);
  if (icon) candidates.push(icon.toString());
  candidates.push(new URL("/favicon.ico", source.origin).toString());
  return [...new Set(candidates)];
}

export function detectFaviconContentType(body: Buffer): string | null {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return "image/jpeg";
  }
  if (body.length >= 6 && ["GIF87a", "GIF89a"].includes(body.subarray(0, 6).toString("ascii"))) {
    return "image/gif";
  }
  if (body.length >= 4 && body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0) {
    return "image/x-icon";
  }
  if (
    body.length >= 12
    && body.subarray(0, 4).toString("ascii") === "RIFF"
    && body.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

async function readBoundedBody(stream: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FAVICON_BYTES) {
      stream.destroy(new Error("favicon response is too large"));
      throw new Error("favicon response is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function cached(key: string): FaviconCacheEntry | null | undefined {
  const entry = faviconCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    faviconCache.delete(key);
    return undefined;
  }
  return entry.body ? entry : null;
}

function storeCache(key: string, entry: FaviconCacheEntry): void {
  faviconCache.delete(key);
  faviconCache.set(key, entry);
  while (faviconCache.size > MAX_CACHE_ENTRIES) {
    const oldest = faviconCache.keys().next().value;
    if (!oldest) break;
    faviconCache.delete(oldest);
  }
}

async function fetchFavicon(target: string): Promise<{ body: Buffer; contentType: string } | null> {
  const existing = cached(target);
  if (existing !== undefined) {
    return existing?.body && existing.contentType
      ? { body: existing.body, contentType: existing.contentType }
      : null;
  }
  try {
    const response = await safeAgentRequest(target, {
      headers: {
        Accept: "image/avif,image/webp,image/png,image/*,*/*;q=0.2",
        "User-Agent": "Employee-Agent-Favicon/1.0",
      },
      timeoutMs: 3_500,
    });
    const declaredLength = Number(response.headers["content-length"] || 0);
    if (response.status !== 200 || declaredLength > MAX_FAVICON_BYTES) {
      response.body.resume();
      storeCache(target, { expiresAt: Date.now() + FAILURE_TTL_MS });
      return null;
    }
    const body = await readBoundedBody(response.body);
    const contentType = detectFaviconContentType(body);
    if (!contentType) {
      storeCache(target, { expiresAt: Date.now() + FAILURE_TTL_MS });
      return null;
    }
    storeCache(target, { body, contentType, expiresAt: Date.now() + SUCCESS_TTL_MS });
    return { body, contentType };
  } catch {
    storeCache(target, { expiresAt: Date.now() + FAILURE_TTL_MS });
    return null;
  }
}

export function registerWebFaviconRoutes(app: express.Express): void {
  app.get("/api/web-favicon", async (req, res) => {
    try {
      await sdk.authenticateRequest(req);
    } catch {
      res.status(401).end();
      return;
    }

    const candidates = resolveFaviconCandidates(req.query.source, req.query.icon);
    if (!candidates.length) {
      res.status(400).end();
      return;
    }
    for (const candidate of candidates) {
      const favicon = await fetchFavicon(candidate);
      if (!favicon) continue;
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("Content-Type", favicon.contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(favicon.body);
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=600");
    res.status(404).end();
  });
}
