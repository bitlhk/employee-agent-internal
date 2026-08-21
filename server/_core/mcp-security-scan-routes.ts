import { createHash } from "node:crypto";
import type { Express, Request } from "express";
import { createContext } from "./context";
import { adminMfaWriteAccess } from "./admin-mfa-policy";
import { getEnterpriseMcpConnection } from "../db";
import { logError } from "./observability/logger";
import { auditActor, auditRequest, recordAuditBestEffort } from "./audit-events";
import { scanUploadForMalware } from "./upload-security";
import { mcpSecurityScannerEnabled, pendingMcpSecurityScan, scanMcpSourceSecurity } from "./mcp-security-scanner";
import { saveMcpSecurityScan } from "./mcp-security-scan-store";
import { runSkillWork } from "./skills/skill-work-queues";

const MAX_BYTES = 30 * 1024 * 1024;

async function readBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_BYTES) throw Object.assign(new Error("MCP 源码包超过 30MB 限制"), { statusCode: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function registerMcpSecurityScanRoutes(app: Express): void {
  app.post("/api/admin/mcp-security-scan", async (req, res) => {
    try {
      const context = await createContext({ req, res, info: {} as any });
      if (!context.user || context.user.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }
      const mfa = await adminMfaWriteAccess(context.user);
      if (mfa.required && !mfa.fresh) { res.status(403).json({ error: "ADMIN_MFA_REQUIRED" }); return; }
      if (!mcpSecurityScannerEnabled()) { res.status(412).json({ error: "MCP 安全扫描尚未启用" }); return; }
      const serverId = String(req.query.serverId || req.header("x-mcp-server-id") || "").trim();
      if (!serverId) { res.status(400).json({ error: "serverId required" }); return; }
      if (!(await getEnterpriseMcpConnection(serverId))) { res.status(404).json({ error: "企业 MCP 不存在" }); return; }
      const file = await readBody(req);
      if (!file.length) { res.status(400).json({ error: "源码包不能为空" }); return; }
      const malware = await scanUploadForMalware(file);
      if (!malware.ok) { res.status(400).json({ error: malware.error || "源码包杀毒未通过" }); return; }
      const fingerprint = createHash("sha256").update(file).digest("hex");
      const pending = pendingMcpSecurityScan(serverId, fingerprint);
      await saveMcpSecurityScan(pending);
      await recordAuditBestEffort({
        category: "security",
        action: "mcp.security_scan.requested",
        result: "success",
        severity: "high",
        ...auditActor(context.user),
        ...auditRequest(req),
        targetType: "enterprise_mcp",
        targetId: serverId,
        resourceType: "mcp_source_package",
        resourceId: fingerprint,
        metadata: { provider: "aig-mcp-scan", mode: "observe", scanType: "source_static" },
      });
      res.json({ ok: true, scan: pending });
      setImmediate(() => {
        void runSkillWork("security", async () => {
          const result = await scanMcpSourceSecurity({ serverId, file, fingerprint });
          await saveMcpSecurityScan(result);
          await recordAuditBestEffort({
            category: "security",
            action: "mcp.security_scan.completed",
            result: result.status === "failed" ? "failed" : result.verdict === "block" ? "warning" : "success",
            severity: result.verdict === "block" ? "high" : result.verdict === "review" ? "medium" : "info",
            ...auditActor(context.user),
            targetType: "enterprise_mcp",
            targetId: serverId,
            resourceType: "mcp_source_package",
            resourceId: fingerprint,
            errorCode: result.errorCode || null,
            metadata: { provider: result.provider, verdict: result.verdict, scannerVersion: result.scannerVersion, summary: result.summary },
          });
        }).catch(error => logError("mcp_security.scan_failed", error, { serverId }));
      });
    } catch (error) {
      logError("mcp_security.upload_failed", error);
      res.status(Number((error as any)?.statusCode || 500)).json({ error: error instanceof Error ? error.message : "MCP 安全扫描失败" });
    }
  });
}
