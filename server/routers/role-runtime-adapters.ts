import {
  type RoleRuntimeAdapter,
  type RoleRuntimeProvisionInput,
  type RoleRuntimeProvisionResult,
  type RoleRuntimeReconcileInput,
  type RoleRuntimeReconcileResult,
} from "../_core/role-runtime-adapter";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { writeJiuwenSwarmRoleScopeManifest } from "../_core/jiuwenswarm-role-scope";
import { ensureJiuwenSwarmWorkspacePermission } from "../_core/jiuwenswarm-permissions";
import { resolveRuntimeWorkspaceByIds } from "../_core/helpers";
import { skillSourceDirsForRuntime } from "../_core/skills/skill-store";
import { isJiuwenClawRuntimeEnabled } from "../_core/jiuwenclaw-bridge";
import { bumpSessionEpoch, readSessionEpoch } from "../_core/helpers";
import { refreshJiuwenRuntimeCapabilities } from "../_core/jiuwenswarm-runtime-refresh";
import { resolvePersistedAgentMcpSelection } from "../db/agent-mcp-preferences";
import type { AgentRuntime } from "../_core/role-templates";
import { retiredRuntimeMessage } from "../_core/runtime-policy";
import { refreshEnterpriseRuntimeAssetsIfBound } from "../_core/enterprise-runtime-assets";
import { activeJiuwenSwarmRegistrySkillIds, skillRegistry } from "../_core/skills/skill-registry";

export function missingDefaultRoleSkills(defaultSkillIds: string[], sourceDirs: string[]): string[] {
  return Array.from(new Set(defaultSkillIds.map((id) => String(id || "").trim()).filter(Boolean)))
    .filter((skillId) => !sourceDirs.some((dir) => existsSync(path.join(dir, skillId, "SKILL.md"))))
    .sort();
}

function assertDefaultRoleSkillsAvailable(input: RoleRuntimeReconcileInput | RoleRuntimeProvisionInput): void {
  const missing = missingDefaultRoleSkills(
    input.effectiveAssets.skills.default,
    skillSourceDirsForRuntime(),
  );
  if (missing.length > 0) {
    throw new Error(`岗位 ${input.role.name} 的默认技能尚未部署: ${missing.join(", ")}`);
  }
}

class JiuwenSwarmRoleRuntimeAdapter implements RoleRuntimeAdapter {
  readonly runtime = "jiuwenswarm" as const;

  provision(input: RoleRuntimeProvisionInput): RoleRuntimeProvisionResult {
    if (!isJiuwenClawRuntimeEnabled()) {
      throw new Error("jiuwenswarm runtime is not enabled; configure JiuwenSwarm before provisioning an agent");
    }
    assertDefaultRoleSkillsAvailable(input);
    const workspaceDir = resolveRuntimeWorkspaceByIds(input.adoptId, input.agentId);
    mkdirSync(path.join(workspaceDir, "skills"), { recursive: true });
    const workspacePermission = ensureJiuwenSwarmWorkspacePermission(workspaceDir);
    return {
      ok: true,
      mode: "jiuwenswarm-workspace",
      runtime: this.runtime,
      message: "jiuwenswarm workspace prepared; role-scoped skills are reconciled separately",
      result: {
        adoptId: input.adoptId,
        agentId: input.agentId,
        workspaceDir,
        workspacePermission,
        roleTemplate: input.role.id,
        effectiveAssets: input.effectiveAssets,
      },
    };
  }

  async reconcileSkills(input: RoleRuntimeReconcileInput): Promise<RoleRuntimeReconcileResult> {
    return this.reconcileAssets(input);
  }

  async reconcileMcp(input: RoleRuntimeReconcileInput): Promise<RoleRuntimeReconcileResult> {
    return this.reconcileAssets(input);
  }

  async reconcileAssets(input: RoleRuntimeReconcileInput): Promise<RoleRuntimeReconcileResult> {
    assertDefaultRoleSkillsAvailable(input);
    const workspaceDir = resolveRuntimeWorkspaceByIds(input.adoptId, input.agentId);
    const workspacePermission = ensureJiuwenSwarmWorkspacePermission(workspaceDir);
    let activeSkillIds = input.activeSkillIds;
    if (activeSkillIds === undefined) {
      const listed = await skillRegistry.listSkills(input.adoptId);
      activeSkillIds = listed.ok
        ? activeJiuwenSwarmRegistrySkillIds(
          listed.value,
          input.adoptId,
          [...input.effectiveAssets.skills.default, ...input.effectiveAssets.skills.optional],
        )
        : [];
    }
    const selection = await resolvePersistedAgentMcpSelection(input.adoptId, input.effectiveAssets);
    const result = writeJiuwenSwarmRoleScopeManifest({
      workspaceDir,
      role: input.role,
      effectiveAssets: input.effectiveAssets,
      activeSkillIds,
      disabledDefaultSkillIds: input.disabledDefaultSkillIds,
      activeMcpServerIds: selection.enabledServerIds,
      includePlatformMcp: input.includePlatformMcp,
      skillSourceDirs: skillSourceDirsForRuntime(),
    });
    const changed =
      Number(result.changed) +
      Number(result.identityChanged) +
      Number(result.userChanged) +
      result.linkedSharedSkills.length +
      result.removedSharedSkills.length;
    const totalChanged = changed + Number(workspacePermission.changed);
    if (totalChanged > 0) {
      await refreshEnterpriseRuntimeAssetsIfBound(input.adoptId).catch(() => null);
    }
    return {
      ok: true,
      applied: totalChanged > 0,
      changed: totalChanged,
      reason: `${result.manifestPath}; enabledMcp=${selection.enabledServerIds.length}; workspacePermission=${workspacePermission.changed ? "updated" : "ok"}`,
    };
  }

  bumpSessionEpoch(adoptId: string): number {
    return bumpSessionEpoch(adoptId);
  }

  async refreshCapabilities(adoptId: string): Promise<number> {
    await refreshJiuwenRuntimeCapabilities(adoptId);
    return readSessionEpoch(adoptId);
  }

  audit(): void {
    // Central audit is still recorded by the caller.
  }
}

const jiuwenSwarmAdapter = new JiuwenSwarmRoleRuntimeAdapter();

export function getRoleRuntimeAdapter(runtime: AgentRuntime): RoleRuntimeAdapter {
  if (runtime !== "jiuwenswarm") {
    throw new Error(retiredRuntimeMessage());
  }
  return jiuwenSwarmAdapter;
}

export function isJiuwenSwarmProvisionEnabled(): boolean {
  return String(process.env.JIUWENSWARM_PROVISION_ENABLED || process.env.JIUWENCLAW_PROVISION_ENABLED || "")
    .toLowerCase() === "true";
}
