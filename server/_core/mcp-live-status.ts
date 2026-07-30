export type McpLiveTool = {
  name: string;
  description: string;
};

export type McpLiveStatus = {
  serverId: string;
  status: "live" | "unavailable" | "unsupported";
  tools: McpLiveTool[];
  checkedAt: string;
  error?: string;
};

type McpServerConfig = Record<string, unknown>;

type CachedMcpLiveStatus = {
  freshUntil: number;
  staleUntil: number;
  value: McpLiveStatus;
};

type McpLiveStatusResolverOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  staleMs?: number;
  timeoutMs?: number;
};

export const MCP_TOOLS_LIVE_TTL_MS = 45_000;
export const MCP_TOOLS_LIVE_STALE_MS = 5 * 60_000;

function normalizeMcpTransport(raw: McpServerConfig): string {
  return String(raw.transport || raw.type || "").trim().toLowerCase();
}

function normalizeMcpUrl(raw: McpServerConfig): string {
  return String(raw.url || raw.endpoint || "").trim();
}

function normalizeMcpHeaders(raw: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = raw.headers && typeof raw.headers === "object"
    ? raw.headers as Record<string, unknown>
    : {};
  for (const [key, value] of Object.entries(source)) {
    if (!key) continue;
    headers[key] = String(value ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      if (name === "OPENCLAW_AGENT_ID") return "";
      return process.env[name] || "";
    });
  }
  return headers;
}

function readMcpToolInclude(raw: McpServerConfig): Set<string> | null {
  const filter = raw.toolFilter && typeof raw.toolFilter === "object"
    ? raw.toolFilter as Record<string, unknown>
    : {};
  if (!Array.isArray(filter.include)) return null;
  const names = filter.include.map((item) => String(item || "").trim()).filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

export function parseMcpToolsListPayload(text: string): McpLiveTool[] {
  const payload = String(text || "").trim();
  if (!payload) return [];
  const candidates: string[] = [];
  if (payload.includes("\ndata:") || payload.startsWith("data:")) {
    const dataLines = payload
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    candidates.push(...dataLines.reverse());
  }
  candidates.push(payload);

  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate) as Record<string, unknown>;
      const result = json.result && typeof json.result === "object"
        ? json.result as Record<string, unknown>
        : {};
      const data = json.data && typeof json.data === "object"
        ? json.data as Record<string, unknown>
        : {};
      const tools = result.tools || json.tools || data.tools;
      if (!Array.isArray(tools)) continue;
      return tools
        .map((tool) => {
          const row = tool && typeof tool === "object" ? tool as Record<string, unknown> : {};
          return {
            name: String(row.name || "").trim(),
            description: String(row.description || "").trim(),
          };
        })
        .filter((tool) => tool.name);
    } catch {
      continue;
    }
  }
  return [];
}

export function createMcpLiveStatusResolver(options: McpLiveStatusResolverOptions = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const ttlMs = options.ttlMs ?? MCP_TOOLS_LIVE_TTL_MS;
  const staleMs = Math.max(ttlMs, options.staleMs ?? MCP_TOOLS_LIVE_STALE_MS);
  const timeoutMs = options.timeoutMs ?? 2_500;
  const cache = new Map<string, CachedMcpLiveStatus>();
  const inFlight = new Map<string, Promise<McpLiveStatus>>();

  const probe = async (serverId: string, raw: McpServerConfig): Promise<McpLiveStatus> => {
    const startedAt = now();
    const checkedAt = new Date(startedAt).toISOString();
    const transport = normalizeMcpTransport(raw);
    const url = normalizeMcpUrl(raw);
    if (!url || (transport && !["url", "streamable-http", "http"].includes(transport))) {
      return { serverId, status: "unsupported", tools: [], checkedAt };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          connection: "close",
          ...normalizeMcpHeaders(raw),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let tools = parseMcpToolsListPayload(text);
      const include = readMcpToolInclude(raw);
      if (include) tools = tools.filter((tool) => include.has(tool.name));
      return { serverId, status: "live", tools, checkedAt };
    } catch (error) {
      const detail = error instanceof Error ? error : new Error(String(error || "fetch failed"));
      return {
        serverId,
        status: "unavailable",
        tools: [],
        checkedAt,
        error: detail.name === "AbortError" ? "timeout" : detail.message,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const refresh = (serverId: string, raw: McpServerConfig): Promise<McpLiveStatus> => {
    const cacheKey = `${serverId}:${normalizeMcpUrl(raw)}`;
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const task = probe(serverId, raw)
      .then((value) => {
        const completedAt = now();
        cache.set(cacheKey, {
          freshUntil: completedAt + ttlMs,
          staleUntil: completedAt + staleMs,
          value,
        });
        return value;
      })
      .finally(() => {
        if (inFlight.get(cacheKey) === task) inFlight.delete(cacheKey);
      });
    inFlight.set(cacheKey, task);
    return task;
  };

  const fetchOne = async (
    serverId: string,
    raw: McpServerConfig,
    fetchOptions: { force?: boolean } = {},
  ): Promise<McpLiveStatus> => {
    const cacheKey = `${serverId}:${normalizeMcpUrl(raw)}`;
    const currentTime = now();
    const cached = cache.get(cacheKey);
    if (!fetchOptions.force && cached?.freshUntil && cached.freshUntil > currentTime) {
      return cached.value;
    }
    if (!fetchOptions.force && cached?.staleUntil && cached.staleUntil > currentTime) {
      void refresh(serverId, raw);
      return cached.value;
    }
    return refresh(serverId, raw);
  };

  return {
    async fetchStatuses(
      servers: Record<string, McpServerConfig>,
      allowedServerIds: Set<string>,
      fetchOptions: { force?: boolean } = {},
    ): Promise<Record<string, McpLiveStatus>> {
      const entries = Object.entries(servers).filter(
        ([serverId, raw]) => allowedServerIds.has(serverId) && !Boolean(raw.disabled),
      );
      const rows = await Promise.all(
        entries.map(([serverId, raw]) => fetchOne(serverId, raw, fetchOptions)),
      );
      return Object.fromEntries(rows.map((row) => [row.serverId, row]));
    },
    clear(): void {
      cache.clear();
      inFlight.clear();
    },
  };
}

const defaultMcpLiveStatusResolver = createMcpLiveStatusResolver();

export function fetchMcpLiveStatuses(
  servers: Record<string, McpServerConfig>,
  allowedServerIds: Set<string>,
  options: { force?: boolean } = {},
): Promise<Record<string, McpLiveStatus>> {
  return defaultMcpLiveStatusResolver.fetchStatuses(servers, allowedServerIds, options);
}
