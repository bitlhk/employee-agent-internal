import { existsSync } from "node:fs";
import type { Express } from "express";
import {
  insertSkillMarketItem,
  listApprovedSkillMarketItems,
  listSkillInvocationCounts,
} from "../../../db";
import { requireClawOwner } from "../../helpers";
import { logError } from "../../observability/logger";
import { skillInstaller } from "../skill-installer";
import { toPublicSkillMarketItem } from "../skill-market-policy";
import { skillRegistry } from "../skill-registry";
import { parseSkillSourceDirectory } from "../skill-source";
import { skillStoreMarketplaceDir } from "../skill-store";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function registryErrorStatus(kind?: string): number {
  if (kind === "not_found") return 404;
  if (kind === "permission_denied") return 403;
  if (kind === "validation_failed") return 400;
  return 500;
}

export function registerSkillMarketRoutes(app: Express): void {
  app.get("/api/claw/skill-market/list", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) {
        res.status(400).json({ error: "adoptId required" });
        return;
      }
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const roleTemplate = String(claw.roleTemplate || "general-assistant");
      const rows = await listApprovedSkillMarketItems();
      const invocationCounts = await listSkillInvocationCounts(
        rows.map((item) => String(item.skillId || "").trim()),
      ).catch(() => ({} as Record<string, number>));
      res.json({
        items: rows.map((item) => {
          const skillId = String(item.skillId || "").trim();
          return { ...toPublicSkillMarketItem(item), invocationCount: invocationCounts[skillId] || 0 };
        }),
        roleTemplate,
        filtered: false,
      });
    } catch (error) {
      logError("skill_market.list_failed", error);
      res.status(500).json({ error: "list skill market failed" });
    }
  });

  app.post("/api/claw/skill-market/submit", async (req, res) => {
    try {
      const body = record(req.body);
      const adoptId = String(body.adoptId || "").trim();
      const skillId = String(body.skillId || "").trim();
      const version = String(body.version || "1.0.0").trim().slice(0, 32) || "1.0.0";
      if (!adoptId || !skillId) {
        res.status(400).json({ error: "adoptId and skillId required" });
        return;
      }

      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const listed = await skillRegistry.listSkills(adoptId);
      if (!listed.ok) {
        res.status(registryErrorStatus(listed.error.kind)).json({
          error: listed.error.detail,
          kind: listed.error.kind,
        });
        return;
      }
      const skill = listed.value.find((item) => item.id === skillId);
      if (!skill) {
        res.status(404).json({ error: "skill not found" });
        return;
      }
      if (!["uploaded", "generated", "runtime_imported"].includes(skill.source.kind)) {
        res.status(400).json({
          error: "only uploaded, generated or runtime-imported skills can be submitted",
        });
        return;
      }
      if (!skill.source.sourcePath || !existsSync(skill.source.sourcePath)) {
        res.status(404).json({ error: "skill source missing" });
        return;
      }
      if (!skillInstaller.canInstall(skill.source.sourcePath)) {
        res.status(400).json({ error: "unsupported skill source" });
        return;
      }

      const pendingDir = `${skillStoreMarketplaceDir()}/pending/${skill.id}-${Date.now()}`;
      skillInstaller.installFromSource(skill.source.sourcePath, pendingDir);
      const parsed = parseSkillSourceDirectory(pendingDir, skill.id);
      const marketItemId = await insertSkillMarketItem({
        skillId: parsed.skillId || skill.id,
        name: skill.source.displayName || parsed.displayName || skill.id,
        description: skill.source.description || parsed.description || null,
        author: "中队专区",
        authorUserId: Number(claw.userId || 0) || null,
        version,
        category: "general",
        origin: "squad",
        status: "pending",
        license: "内部共享",
        packagePath: pendingDir,
      });

      res.json({ ok: true, marketItemId, status: "pending" });
    } catch (error) {
      logError("skill_market.submit_failed", error);
      res.status(500).json({ error: "submit skill to market failed" });
    }
  });
}
