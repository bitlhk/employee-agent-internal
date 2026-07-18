import { drainAuditDlq } from "./audit-ledger";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export function startAuditDlqWorker(): () => void {
  if (process.env.AUDIT_DLQ_DRAIN_ENABLED === "false") return () => {};
  const configured = Number(process.env.AUDIT_DLQ_DRAIN_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(configured) ? Math.max(30_000, configured) : DEFAULT_INTERVAL_MS;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await drainAuditDlq();
      if (!result.locked && (result.scanned > 0 || result.failed > 0 || result.invalid > 0)) {
        console.log("[AUDIT-DLQ] drain completed", result);
      }
    } catch (error) {
      console.error("[AUDIT-DLQ] drain failed", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(run, 15_000);
  const timer = setInterval(run, intervalMs);
  initial.unref();
  timer.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
