import { existsSync } from "node:fs";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { SkillSource } from "../../shared/types/skill";
import {
  getClawByAdoptId,
  getSkillMarketItem,
  getSkillVersionByLegacyMarketId,
  incrementSkillDownload,
  listApprovedSkillMarketItems,
  listSkillMarketV2Projection,
  resolveSkillPublisherOrganization,
  syncGlobalOpenSourceSkillGrants,
} from "../db";
import {
  auditActor,
  auditRequest,
  recordAuditBestEffort,
} from "../_core/audit-events";
import { resolveActiveAgentRuntime } from "../_core/runtime-policy";
import { installApprovedSkillVersion } from "../_core/skills/skill-market-installation";
import { toPublicSkillMarketItem } from "../_core/skills/skill-market-policy";
import { parseSkillSourceDirectory } from "../_core/skills/skill-source";
import { remapLegacySkillMarketPath } from "../_core/skills/skill-store";
import { skillRegistry } from "../_core/skills/skill-registry";
import { protectedProcedure } from "../_core/trpc";
import { assertClawOwnerOrThrow } from "./helpers";

export const clawSkillMarketProcedures = {
  marketList: protectedProcedure
    .input(
      z.object({ adoptId: z.string().min(1).max(64).optional() }).optional()
    )
    .query(async ({ input, ctx }) => {
      await syncGlobalOpenSourceSkillGrants({ actor: "market-list" });
      const rows = await listApprovedSkillMarketItems();
      const organizationId = await resolveSkillPublisherOrganization(
        ctx.user!.id
      );
      const projection = await listSkillMarketV2Projection(
        rows.map(row => String(row.skillId || "")).filter(Boolean)
      ).catch(() => ({ identities: [], versions: [], installations: [] }));
      const identityBySkillId = new Map(
        projection.identities.map(identity => [identity.skillId, identity])
      );
      const items = rows
        .filter(row => {
          const identity = identityBySkillId.get(String(row.skillId || ""));
          return (
            !identity ||
            identity.visibility === "platform" ||
            identity.organizationId === organizationId
          );
        })
        .map(row => toPublicSkillMarketItem(row));
      const adoptId = String(input?.adoptId || "").trim();
      if (!adoptId) return items;
      await assertClawOwnerOrThrow(ctx, adoptId);
      return items;
    }),

  marketInstall: protectedProcedure
    .input(
      z.object({
        marketId: z.number(),
        adoptId: z.string().min(1).max(64),
        versionId: z.string().min(1).max(64).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (input.adoptId.startsWith("lgh-")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Legacy runtime has been archived.",
        });
      }
      await assertClawOwnerOrThrow(ctx, input.adoptId);
      const claw = await getClawByAdoptId(input.adoptId);
      const linkedMarketVersion = input.versionId
        ? undefined
        : await getSkillVersionByLegacyMarketId(input.marketId);
      const targetVersionId = input.versionId || linkedMarketVersion?.versionId;
      if (targetVersionId) {
        try {
          const organizationId = await resolveSkillPublisherOrganization(
            ctx.user!.id
          );
          const installed = await installApprovedSkillVersion({
            adoptId: input.adoptId,
            versionId: targetVersionId,
            actorUserId: ctx.user!.id,
            organizationId,
          });
          if (installed.version.legacyMarketId) {
            await incrementSkillDownload(installed.version.legacyMarketId);
          }
          await recordAuditBestEffort({
            action: `skill.${installed.operation}`,
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "skill",
            targetId: installed.identity.skillId,
            targetName: installed.identity.displayName,
            resourceType: "agent",
            resourceId: input.adoptId,
            agentInstanceId: input.adoptId,
            runtimeType: resolveActiveAgentRuntime(input.adoptId),
            runtimeAgentId: String(claw?.agentId || ""),
            metadata: {
              identityId: installed.identity.identityId,
              versionId: installed.version.versionId,
              version: installed.version.version,
              artifactSha256: installed.version.artifactSha256,
              operationId: installed.operationId,
              roleTemplate: String(claw?.roleTemplate || "general-assistant"),
            },
          });
          return {
            ok: true,
            skillId: installed.identity.skillId,
            name: installed.identity.displayName,
            item: installed.item,
            warnings: installed.warnings,
            operation: installed.operation,
            versionId: installed.version.versionId,
            version: installed.version.version,
            artifactSha256: installed.version.artifactSha256,
          };
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              error instanceof Error ? error.message : "技能版本安装失败",
          });
        }
      }

      const item = await getSkillMarketItem(input.marketId);
      if (!item || item.status !== "approved") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "技能不存在或未上架",
        });
      }
      const resolvedPackagePath = remapLegacySkillMarketPath(
        item.packagePath || ""
      );
      if (!resolvedPackagePath || !existsSync(resolvedPackagePath)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "技能包源不存在" });
      }

      const parsed = parseSkillSourceDirectory(
        resolvedPackagePath,
        item.skillId || item.name || "market-skill"
      );
      const source: SkillSource = {
        kind: "marketplace",
        skillId: parsed.skillId || item.skillId,
        displayName: item.name || parsed.displayName || item.skillId,
        description: item.description || parsed.description || "",
        sourcePath: resolvedPackagePath,
        marketplaceId: String(item.id),
        version: String(item.version || parsed.manifest?.version || "1.0.0"),
      };
      const installed = await skillRegistry.install(input.adoptId, source);
      if (!installed.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: installed.error.detail,
        });
      }
      await skillRegistry.updateScan(input.adoptId, source.skillId, {
        warnings: parsed.warnings,
        scannedAt: new Date().toISOString(),
      });
      await incrementSkillDownload(input.marketId);
      await recordAuditBestEffort({
        action: "skill.installed",
        ...auditActor(ctx.user),
        ...auditRequest(ctx.req),
        targetType: "skill",
        targetId: source.skillId,
        targetName: source.displayName,
        resourceType: "agent",
        resourceId: input.adoptId,
        agentInstanceId: input.adoptId,
        runtimeType: resolveActiveAgentRuntime(input.adoptId),
        runtimeAgentId: String(claw?.agentId || ""),
        metadata: {
          marketplaceId: input.marketId,
          version: source.version,
          warningCount: parsed.warnings.length,
          roleTemplate: String(claw?.roleTemplate || "general-assistant"),
        },
      });
      return {
        ok: true,
        skillId: source.skillId,
        name: source.displayName,
        item: installed.value,
        warnings: parsed.warnings,
      };
    }),
};
