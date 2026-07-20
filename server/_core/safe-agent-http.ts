import { lookup } from "dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "http";
import { request as httpsRequest } from "https";
import { isIP } from "net";
import { isPrivateManagedBrowserIp } from "./managed-browser";

export type AgentEndpointAddress = { address: string; family: 4 | 6 };

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function endpointAllowlist(): Set<string> {
  return new Set(splitCsv(process.env.EA_AGENT_ENDPOINT_ALLOWLIST || ""));
}

function privateEndpointsGloballyAllowed(): boolean {
  return String(process.env.EA_ALLOW_PRIVATE_AGENT_ENDPOINTS || "").toLowerCase() === "true";
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function endpointIsAllowlisted(url: URL, allowlist = endpointAllowlist()): boolean {
  const hostname = normalizedHostname(url);
  return allowlist.has(hostname) || allowlist.has(url.host.toLowerCase());
}

export function parseAgentEndpointUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Agent endpoint URL is invalid");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("Agent endpoint must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Agent endpoint credentials must be configured separately");
  }
  return parsed;
}

export function selectAgentEndpointAddress(
  url: URL,
  records: AgentEndpointAddress[],
  options: { allowPrivate?: boolean; allowlist?: Set<string> } = {},
): AgentEndpointAddress {
  if (records.length === 0) throw new Error("Agent endpoint hostname did not resolve");
  const allowPrivate = options.allowPrivate === true || endpointIsAllowlisted(url, options.allowlist);
  if (!allowPrivate && records.some((record) => isPrivateManagedBrowserIp(record.address))) {
    throw new Error("Agent endpoint resolves to a private or local address");
  }
  return records.find((record) => record.family === 4) || records[0];
}

async function resolveAgentEndpoint(
  url: URL,
  options: { allowPrivate?: boolean; allowlist?: Set<string> } = {},
): Promise<AgentEndpointAddress> {
  const hostname = normalizedHostname(url);
  const family = isIP(hostname);
  const records = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true }) as AgentEndpointAddress[];
  return selectAgentEndpointAddress(url, records, {
    allowPrivate: options.allowPrivate ?? privateEndpointsGloballyAllowed(),
    allowlist: options.allowlist,
  });
}

export type SafeAgentRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowPrivate?: boolean;
  privateHostAllowlist?: Set<string>;
};

export type SafeAgentResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage;
};

export async function safeAgentRequest(rawUrl: string, options: SafeAgentRequestOptions = {}): Promise<SafeAgentResponse> {
  const url = parseAgentEndpointUrl(rawUrl);
  const resolved = await resolveAgentEndpoint(url, {
    allowPrivate: options.allowPrivate,
    allowlist: options.privateHostAllowlist,
  });
  const body = options.body;
  const headers = { ...(options.headers || {}) };
  if (body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }

  return await new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Agent endpoint request aborted"));
      return;
    }
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      method: options.method || "GET",
      headers,
      lookup: ((_hostname: string, lookupOptions: any, callback: any) => {
        if (lookupOptions?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      }) as any,
    }, (res) => {
      const status = Number(res.statusCode || 0);
      if (status >= 300 && status < 400) {
        res.resume();
        reject(new Error("Agent endpoint redirects are not allowed"));
        return;
      }
      resolve({ status, headers: res.headers, body: res });
    });
    const onAbort = () => req.destroy(new Error("Agent endpoint request aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.once("close", () => options.signal?.removeEventListener("abort", onAbort));
    req.setTimeout(Math.max(1_000, options.timeoutMs || 30_000), () => {
      req.destroy(new Error("Agent endpoint request timed out"));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function readSafeAgentResponseText(response: SafeAgentResponse, maxBytes = 16 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      response.body.destroy(new Error("Agent endpoint response is too large"));
      throw new Error("Agent endpoint response is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
