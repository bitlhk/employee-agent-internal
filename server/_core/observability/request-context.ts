import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type RequestContext = {
  requestId: string;
  method: string;
  route: string;
  userId?: number;
  adoptId?: string;
  runtime?: string;
};

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const storage = new AsyncLocalStorage<RequestContext>();

export function normalizeIncomingRequestId(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = typeof candidate === "string" ? candidate.trim() : "";
  return REQUEST_ID_RE.test(normalized) ? normalized : randomUUID();
}
export function runWithRequestContext<T>(context: RequestContext, action: () => T): T {
  return storage.run(context, action);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function updateRequestContext(patch: Partial<Omit<RequestContext, "requestId">>): void {
  const context = storage.getStore();
  if (!context) return;
  if (patch.method) context.method = String(patch.method).slice(0, 16);
  if (patch.route) context.route = String(patch.route).slice(0, 180);
  if (Number.isInteger(patch.userId) && Number(patch.userId) > 0) context.userId = Number(patch.userId);
  if (patch.adoptId) context.adoptId = String(patch.adoptId).slice(0, 96);
  if (patch.runtime) context.runtime = String(patch.runtime).slice(0, 48);
}
