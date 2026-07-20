import { readFileSync } from "fs";
import path from "path";
import { z } from "zod";

const APP_ROOT = process.env.APP_ROOT || process.cwd();

const RoleStatusSchema = z.enum(["mvp", "planned", "disabled"]);
const PermissionProfileSchema = z.enum(["plus", "internal"]);
const RuntimeSchema = z.enum(["jiuwenswarm", "openclaw"]);
const IndustrySchema = z.enum(["general", "banking", "insurance", "securities"]);
const VisibleZoneSchema = z.enum(["opensource", "finance", "squad"]);
const RuntimeAssetIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);

const SkillMcpRequirementSchema = z.object({
  servers: z.record(
    RuntimeAssetIdSchema,
    z.array(RuntimeAssetIdSchema).max(100),
  ).default({}),
});

const RoleTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  status: RoleStatusSchema,
  displayOrder: z.number().int(),
  permissionProfile: PermissionProfileSchema,
  defaultVisibleZones: z.array(VisibleZoneSchema),
  defaultSkills: z.array(z.string()),
  optionalSkills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  mcpTools: z.array(z.string()),
  defaultModel: z.string().min(1),
  runtime: RuntimeSchema,
  dataScope: z.string().default(""),
});

const IndustryBlockSchema = z.object({
  name: z.string().min(1),
  roles: z.record(z.string(), RoleTemplateSchema),
});

const BaselineSchema = z.object({
  version: z.string().min(1),
  principles: z.array(z.string()).default([]),
  skillRequirements: z.record(RuntimeAssetIdSchema, SkillMcpRequirementSchema).default({}),
  schema: z.object({
    defaultRole: z.string().min(1),
    permissionProfiles: z.array(PermissionProfileSchema),
    runtimes: z.array(RuntimeSchema),
    origins: z.array(z.string()),
    roleStatus: z.array(RoleStatusSchema),
    visibleZones: z.array(VisibleZoneSchema),
    notes: z.array(z.string()).default([]),
  }),
  runtimePolicy: z.object({
    defaultRuntime: RuntimeSchema,
    fallbackRuntime: RuntimeSchema,
    selection: z.string().default(""),
  }),
  uiPolicy: z.unknown().optional(),
  industries: z.record(IndustrySchema, IndustryBlockSchema),
});

export type AgentIndustry = z.infer<typeof IndustrySchema>;
export type AgentRuntime = z.infer<typeof RuntimeSchema>;
export type AgentRoleStatus = z.infer<typeof RoleStatusSchema>;
export type SkillMcpRequirement = z.infer<typeof SkillMcpRequirementSchema>;
export type AgentRoleTemplate = z.infer<typeof RoleTemplateSchema> & {
  id: string;
  industry: AgentIndustry;
  industryName: string;
};
export type RoleSkillMcpBaseline = z.infer<typeof BaselineSchema>;

let cachedBaseline: RoleSkillMcpBaseline | null = null;
let cachedTemplates: AgentRoleTemplate[] | null = null;

function baselinePath(): string {
  return process.env.ROLE_SKILL_MCP_BASELINE_PATH || path.join(APP_ROOT, "docs/design/role-skill-mcp-baseline.json");
}

function loadBaselineFromDisk(): RoleSkillMcpBaseline {
  const raw = readFileSync(baselinePath(), "utf8");
  const parsed = BaselineSchema.parse(JSON.parse(raw));
  const roleIds = new Set<string>();
  for (const [industry, block] of Object.entries(parsed.industries) as Array<[AgentIndustry, z.infer<typeof IndustryBlockSchema>]>) {
    for (const roleId of Object.keys(block.roles)) {
      if (roleIds.has(roleId)) {
        throw new Error(`Duplicate role template id in baseline: ${roleId}`);
      }
      roleIds.add(roleId);
      const role = block.roles[roleId];
      if (industry === "general" && roleId !== parsed.schema.defaultRole) {
        throw new Error(`General industry can only contain default role ${parsed.schema.defaultRole}, got ${roleId}`);
      }
    }
  }
  if (!roleIds.has(parsed.schema.defaultRole)) {
    throw new Error(`Baseline default role not found: ${parsed.schema.defaultRole}`);
  }
  if (!parsed.industries.general?.roles?.[parsed.schema.defaultRole]) {
    throw new Error(`Baseline default role must live under industries.general: ${parsed.schema.defaultRole}`);
  }
  return parsed;
}

export function getRoleSkillMcpBaseline(): RoleSkillMcpBaseline {
  if (!cachedBaseline) cachedBaseline = loadBaselineFromDisk();
  return cachedBaseline;
}

export function getSkillMcpRequirement(skillId: string): SkillMcpRequirement {
  const normalized = String(skillId || "").trim();
  const configured = normalized ? getRoleSkillMcpBaseline().skillRequirements[normalized] : undefined;
  return configured
    ? { servers: Object.fromEntries(Object.entries(configured.servers).map(([serverId, tools]) => [serverId, [...tools]])) }
    : { servers: {} };
}

export function listAgentRoleTemplates(): AgentRoleTemplate[] {
  if (cachedTemplates) return cachedTemplates;
  const baseline = getRoleSkillMcpBaseline();
  const templates: AgentRoleTemplate[] = [];
  for (const [industry, block] of Object.entries(baseline.industries) as Array<[AgentIndustry, z.infer<typeof IndustryBlockSchema>]>) {
    for (const [id, role] of Object.entries(block.roles)) {
      templates.push({ id, industry, industryName: block.name, ...role });
    }
  }
  cachedTemplates = templates.sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));
  return cachedTemplates;
}

export function getAgentRoleTemplate(roleId: string): AgentRoleTemplate | null {
  return listAgentRoleTemplates().find((role) => role.id === roleId) || null;
}

export function getDefaultAgentRoleTemplate(): AgentRoleTemplate {
  const baseline = getRoleSkillMcpBaseline();
  const role = getAgentRoleTemplate(baseline.schema.defaultRole);
  if (!role) throw new Error(`Default role template not found: ${baseline.schema.defaultRole}`);
  return role;
}

export function resolveAgentRoleTemplate(roleId?: string | null): AgentRoleTemplate {
  const requested = String(roleId || "").trim();
  if (!requested) return getDefaultAgentRoleTemplate();
  const role = getAgentRoleTemplate(requested);
  if (!role) throw new Error(`Unknown role template: ${requested}`);
  return role;
}

export function resetRoleTemplateCacheForTests(): void {
  cachedBaseline = null;
  cachedTemplates = null;
}
