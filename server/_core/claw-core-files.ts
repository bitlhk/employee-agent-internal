import express from "express";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import {
  isJiuwenClawAdoptId, requireClawOwner, resolveClawWorkspace, computeEtag,
} from "./helpers";
import { refreshEnterpriseRuntimeAssetsIfBound } from "./enterprise-runtime-assets";

export function registerCoreFileRoutes(app: express.Express) {

  // ── Core Files (whitelist, owner-scoped) ──
  const CORE_FILE_MAP: Record<string, string> = {
    "AGENTS.md": "AGENTS.md",
    "SOUL.md": "SOUL.md",
    "TOOLS.md": "TOOLS.md",
    "MEMORY.md": "MEMORY.md",
    "IDENTITY.md": "IDENTITY.md",
    "HEARTBEAT.md": "HEARTBEAT.md",
    "USER.md": "USER.md",
    "STYLE.md": "STYLE.md",
    "PLAN.md": "PLAN.md",
    "KNOWLEDGE.md": "KNOWLEDGE.md",
  };

  const resolveCoreFilePath = (workspace: string, name: string, adoptId?: string) => {
    const mapped = isJiuwenClawAdoptId(String(adoptId || "")) && name === "AGENTS.md"
      ? "AGENT.md"
      : CORE_FILE_MAP[name];
    if (!mapped) return null;
    if (mapped.includes("..") || mapped.startsWith("/")) return null;
    return `${workspace}/${mapped}`;
  };

  app.get("/api/claw/core-files", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      if (adoptId.startsWith("lgh-")) return res.status(410).json({ error: "HERMES_RUNTIME_ARCHIVED" });

      const workspace = resolveClawWorkspace(claw);
      const files = Object.keys(CORE_FILE_MAP).map((name) => {
        const fp = resolveCoreFilePath(workspace, name, adoptId)!;
        if (!existsSync(fp)) return { name, exists: false, updatedAt: null, size: null };
        try {
          const st = statSync(fp);
          return { name, exists: true, updatedAt: st.mtime.toISOString(), size: Number(st.size || 0) };
        } catch {
          return { name, exists: false, updatedAt: null, size: null };
        }
      });
      return res.json({ adoptId, workspace, files });
    } catch {
      return res.status(500).json({ error: "core files list failed" });
    }
  });

  app.get("/api/claw/core-files/read", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      const name = String(req.query.name || "").trim();
      if (!adoptId || !name) return res.status(400).json({ error: "adoptId and name required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      if (adoptId.startsWith("lgh-")) return res.status(410).json({ error: "HERMES_RUNTIME_ARCHIVED" });

      const workspace = resolveClawWorkspace(claw);
      const fp = resolveCoreFilePath(workspace, name, adoptId);
      if (!fp) return res.status(400).json({ error: "invalid core file" });

      const content = existsSync(fp) ? String(readFileSync(fp, "utf8") || "") : "";
      const updatedAt = existsSync(fp) ? statSync(fp).mtime.toISOString() : null;
      const etag = computeEtag(content);
      return res.json({ adoptId, workspace, name, content, updatedAt, etag, exists: existsSync(fp) });
    } catch {
      return res.status(500).json({ error: "core file read failed" });
    }
  });

  app.post("/api/claw/core-files/save", async (req, res) => {
    try {
      const body = (req.body || {}) as any;
      const adoptId = String(body.adoptId || "").trim();
      const name = String(body.name || "").trim();
      if (adoptId.startsWith("lgh-")) return res.status(410).json({ error: "HERMES_RUNTIME_ARCHIVED" });
      const content = String(body.content || "");
      const etag = String(body.etag || "").trim();
      if (!adoptId || !name) return res.status(400).json({ error: "adoptId and name required" });

      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const workspace = resolveClawWorkspace(claw);
      const fp = resolveCoreFilePath(workspace, name, adoptId);
      if (!fp) return res.status(400).json({ error: "invalid core file" });

      const current = existsSync(fp) ? String(readFileSync(fp, "utf8") || "") : "";
      const currentEtag = computeEtag(current);
      if (etag && etag !== currentEtag) {
        return res.status(409).json({ error: "CONFLICT", message: "etag mismatch" });
      }

      mkdirSync(workspace, { recursive: true });
      writeFileSync(fp, content, "utf8");
      if (content !== current && (name === "IDENTITY.md" || name === "USER.md")) {
        await refreshEnterpriseRuntimeAssetsIfBound(adoptId).catch(() => null);
      }
      const updatedAt = statSync(fp).mtime.toISOString();
      const nextEtag = computeEtag(content);
      return res.json({ ok: true, adoptId, name, updatedAt, etag: nextEtag });
    } catch {
      return res.status(500).json({ error: "core file save failed" });
    }
  });

}
