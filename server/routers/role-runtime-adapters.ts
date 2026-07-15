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
import { applyOpenClawRoleScope } from "../_core/openclaw-role-scope";
import { OPENCLAW_JSON_PATH, openClawWorkspaceDir, resolveRuntimeWorkspaceByIds } from "../_core/helpers";
import { skillSourceDirsForRuntime } from "../_core/skills/skill-store";
import { isJiuwenClawRuntimeEnabled } from "../_core/jiuwenclaw-bridge";
import { bumpClawSessionEpochBestEffort, provisionEmployeeAgentInstance } from "./helpers";

function noOpReconcile(reason: string): RoleRuntimeReconcileResult {
  return { ok: true, applied: false, changed: 0, skipped: 0, reason };
}

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

class OpenClawRoleRuntimeAdapter implements RoleRuntimeAdapter {
  readonly runtime = "openclaw" as const;

  provision(input: RoleRuntimeProvisionInput): RoleRuntimeProvisionResult {
    assertDefaultRoleSkillsAvailable(input);
    const result = provisionEmployeeAgentInstance({
      adoptId: input.adoptId,
      agentId: input.agentId,
      userId: input.userId,
      permissionProfile: input.permissionProfile,
      ttlDays: input.ttlDays,
    });
    return { ok: true, mode: result.mode, runtime: this.runtime, result };
  }

  reconcileSkills(input: RoleRuntimeReconcileInput): RoleRuntimeReconcileResult {
    assertDefaultRoleSkillsAvailable(input);
    const result = applyOpenClawRoleScope({
      configPath: OPENCLAW_JSON_PATH,
      agentId: input.agentId,
      effectiveAssets: input.effectiveAssets,
      activeSkillIds: input.activeSkillIds,
      disabledDefaultSkillIds: input.disabledDefaultSkillIds,
      workspaceDir: openClawWorkspaceDir(input.agentId),
      skillSourceDirs: skillSourceDirsForRuntime(),
    });
    const changed =
      Number(result.skillAllowlistChanged) +
      Number(result.mcpProjectionChanged) +
      result.linkedSharedSkills.length +
      result.removedSharedSkills.length;
    return {
      ok: true,
      applied: changed > 0,
      changed,
      skipped: result.agentFound ? 0 : 1,
      reason: result.agentFound ? undefined : "OpenClaw agent entry not found in openclaw.json",
    };
  }

  reconcileMcp(_input: RoleRuntimeReconcileInput): RoleRuntimeReconcileResult {
    return noOpReconcile("OpenClaw MCP projection is applied together with role-scoped skill reconciliation");
  }

  bumpSessionEpoch(adoptId: string): number {
    return bumpClawSessionEpochBestEffort(adoptId);
  }

  audit(): void {
    // Central audit is still recorded by the caller. Adapter-level audit hooks
    // become the single capture point once reconcile mutates runtime state.
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

  reconcileSkills(input: RoleRuntimeReconcileInput): RoleRuntimeReconcileResult {
    assertDefaultRoleSkillsAvailable(input);
    const workspaceDir = resolveRuntimeWorkspaceByIds(input.adoptId, input.agentId);
    const workspacePermission = ensureJiuwenSwarmWorkspacePermission(workspaceDir);
    const result = writeJiuwenSwarmRoleScopeManifest({
      workspaceDir,
      role: input.role,
      effectiveAssets: input.effectiveAssets,
      activeSkillIds: input.activeSkillIds,
      disabledDefaultSkillIds: input.disabledDefaultSkillIds,
      skillSourceDirs: skillSourceDirsForRuntime(),
    });
    const changed =
      Number(result.changed) +
      Number(result.identityChanged) +
      Number(result.userChanged) +
      result.linkedSharedSkills.length +
      result.removedSharedSkills.length;
    const totalChanged = changed + Number(workspacePermission.changed);
    return {
      ok: true,
      applied: totalChanged > 0,
      changed: totalChanged,
      reason: `${result.manifestPath}; workspacePermission=${workspacePermission.changed ? "updated" : "ok"}`,
    };
  }

  reconcileMcp(_input: RoleRuntimeReconcileInput): RoleRuntimeReconcileResult {
    return noOpReconcile("jiuwenswarm MCP allowlist is recorded in the role scope manifest; enforcement stays service-side");
  }

  bumpSessionEpoch(adoptId: string): number {
    return bumpClawSessionEpochBestEffort(adoptId);
  }

  audit(): void {
    // Central audit is still recorded by the caller.
  }
}

const adapters = {
  openclaw: new OpenClawRoleRuntimeAdapter(),
  jiuwenswarm: new JiuwenSwarmRoleRuntimeAdapter(),
};

export function getRoleRuntimeAdapter(runtime: keyof typeof adapters): RoleRuntimeAdapter {
  return adapters[runtime];
}

export function isJiuwenSwarmProvisionEnabled(): boolean {
  return String(process.env.JIUWENSWARM_PROVISION_ENABLED || process.env.JIUWENCLAW_PROVISION_ENABLED || "")
    .toLowerCase() === "true";
}
