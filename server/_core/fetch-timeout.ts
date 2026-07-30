const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export function outboundFetchTimeoutMs(): number {
  const configured = Number.parseInt(process.env.EA_OUTBOUND_FETCH_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_FETCH_TIMEOUT_MS;
  return Math.max(1_000, Math.min(120_000, configured));
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = outboundFetchTimeoutMs(),
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const relayAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) relayAbort();
  else upstreamSignal?.addEventListener("abort", relayAbort, { once: true });

  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  timer.unref();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", relayAbort);
  };
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            cleanup();
            streamController.close();
          } else {
            streamController.enqueue(chunk.value);
          }
        } catch (error) {
          cleanup();
          streamController.error(error);
        }
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason);
      },
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return wrapped;
  } catch (error) {
    cleanup();
    throw error;
  }
}
