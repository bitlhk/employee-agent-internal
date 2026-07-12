import { lookup } from "dns/promises";
import { request as httpsRequest } from "https";
import { isIP } from "net";
import { isPrivateManagedBrowserIp } from "./managed-browser";

const FEISHU_WEBHOOK_HOSTS = new Set(["open.feishu.cn", "open.larksuite.com"]);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export type WebhookKind = "feishu" | "generic";
type ResolvedAddress = { address: string; family: 4 | 6 };

function privateHostAllowlist(): Set<string> {
  return new Set(
    String(process.env.NOTIFY_WEBHOOK_PRIVATE_HOST_ALLOWLIST || "")
      .split(",")
      .map((value) => value.trim().replace(/^\[|\]$/g, "").toLowerCase())
      .filter(Boolean),
  );
}

export function parseWebhookUrl(raw: unknown, kind: WebhookKind): URL {
  const value = String(raw || "").trim();
  if (!value) throw new Error("Webhook URL is required");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Webhook URL must use HTTPS");
  if (url.username || url.password) throw new Error("Webhook URL credentials are not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) throw new Error("Webhook hostname is required");
  if (kind === "feishu") {
    if (!FEISHU_WEBHOOK_HOSTS.has(hostname)) throw new Error("Feishu Webhook must use an official Feishu/Lark hostname");
    if (!url.pathname.startsWith("/open-apis/bot/v2/hook/")) throw new Error("Invalid Feishu robot Webhook path");
  }
  if (isIP(hostname) && isPrivateManagedBrowserIp(hostname) && !privateHostAllowlist().has(hostname)) {
    throw new Error("Private or local Webhook addresses are not allowed");
  }
  return url;
}

export function selectWebhookAddress(
  hostnameRaw: string,
  records: ResolvedAddress[],
  allowlist: Set<string> = privateHostAllowlist(),
): ResolvedAddress {
  const hostname = hostnameRaw.replace(/^\[|\]$/g, "").toLowerCase();
  if (records.length === 0) throw new Error("Webhook hostname did not resolve");
  if (!allowlist.has(hostname) && records.some((record) => isPrivateManagedBrowserIp(record.address))) {
    throw new Error("Webhook hostname resolves to a private or local address");
  }
  return records.find((record) => record.family === 4) || records[0];
}

async function resolveWebhookAddress(url: URL): Promise<ResolvedAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  if (family) return selectWebhookAddress(hostname, [{ address: hostname, family: family as 4 | 6 }]);
  const records = await lookup(hostname, { all: true, verbatim: true });
  return selectWebhookAddress(hostname, records as ResolvedAddress[]);
}

export async function validateWebhookTarget(raw: unknown, kind: WebhookKind): Promise<URL> {
  const url = parseWebhookUrl(raw, kind);
  await resolveWebhookAddress(url);
  return url;
}

export async function safePostWebhookJson(
  raw: unknown,
  kind: WebhookKind,
  payload: unknown,
): Promise<{ ok: boolean; status: number; text: string; json: any | null }> {
  const url = parseWebhookUrl(raw, kind);
  const resolved = await resolveWebhookAddress(url);
  const body = JSON.stringify(payload);

  return await new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      lookup: ((_hostname: string, options: any, callback: any) => {
        if (options?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      }) as any,
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("Webhook response is too large"));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        const status = Number(res.statusCode || 0);
        if (status >= 300 && status < 400) {
          reject(new Error("Webhook redirects are not allowed"));
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any | null = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ ok: status >= 200 && status < 300, status, text, json });
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Webhook request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
