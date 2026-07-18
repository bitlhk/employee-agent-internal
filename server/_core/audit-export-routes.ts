import type express from "express";
import { createReadStream } from "fs";
import path from "path";
import { TRPCError } from "@trpc/server";
import { createContext } from "./context";
import { auditActor, auditRequest, recordAuditRequired } from "./audit-events";
import { getAuditExportFile, getAuditExportRecord } from "../routers/audit";
import { adminMfaWriteAccess } from "./admin-mfa-policy";

export function registerAuditExportRoutes(app: express.Express) {
  app.get("/api/audit/exports/:exportId/download", async (req, res) => {
    try {
      const ctx = await createContext({ req, res } as any);
      if (!ctx.user || ctx.user.role !== "admin") {
        return res.status(ctx.user ? 403 : 401).json({ error: ctx.user ? "FORBIDDEN" : "UNAUTHORIZED" });
      }
      const mfa = await adminMfaWriteAccess(ctx.user);
      if (mfa.required && !mfa.fresh) return res.status(403).json({ error: "ADMIN_MFA_REQUIRED" });

      const exportId = String(req.params.exportId || "").trim();
      if (!/^audexp_[a-z0-9]+_[a-f0-9]{12}$/.test(exportId)) {
        return res.status(400).json({ error: "invalid_export_id" });
      }

      const record = await getAuditExportRecord(exportId);
      if (!record) return res.status(404).json({ error: "not_found" });
      if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
        return res.status(410).json({ error: "expired" });
      }

      const result = await getAuditExportFile(exportId);
      if (!result) return res.status(404).json({ error: "not_found" });
      const { filePath } = result;

      await recordAuditRequired({
        action: "audit.export.downloaded",
        ...auditActor(ctx.user),
        ...auditRequest(req),
        targetType: "audit_export",
        targetId: exportId,
        metadata: {
          format: record.format,
          rowCount: record.rowCount,
          fileSizeBytes: record.fileSizeBytes,
          fileHash: record.fileHash,
        },
      });

      const filename = `audit-export-${exportId}.${record.format}`;
      res.setHeader("Content-Type", record.format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", String(record.fileSizeBytes));
      res.setHeader("X-Content-Type-Options", "nosniff");
      createReadStream(path.resolve(filePath)).pipe(res);
    } catch (error: any) {
      if (error instanceof TRPCError) {
        return res.status(500).json({ error: error.message });
      }
      console.error("[AUDIT-EXPORT] download failed", error);
      res.status(500).json({ error: error?.message || "audit export download failed" });
    }
  });
}
