import { z } from "zod";
import { agentRuntimeFamilySchema } from "./agent";

/**
 * Financial Agent Harness manifest contract.
 *
 * This is the declaration layer for Hermes runtime-level workers, skills,
 * MCP/data access, output schemas, and write-holder boundaries. It is not the
 * Workforce Agent Platform/OpenClaw SkillHub contract.
 */

export const AGENT_MANIFEST_ROLES = ["orchestrator", "reader", "analyst", "writer"] as const;
export const agentManifestRoleSchema = z.enum(AGENT_MANIFEST_ROLES);
export type AgentManifestRole = z.infer<typeof agentManifestRoleSchema>;

export const AGENT_MANIFEST_TOOL_NAMES = ["read", "grep", "glob", "write", "edit", "bash", "search"] as const;
export const agentManifestToolNameSchema = z.enum(AGENT_MANIFEST_TOOL_NAMES);
export type AgentManifestToolName = z.infer<typeof agentManifestToolNameSchema>;

export const AGENT_MANIFEST_TRUST_BOUNDARIES = [
  "trusted_runtime",
  "untrusted_input_reader",
  "trusted_data_access",
  "write_holder",
  "audit_review",
] as const;
export const agentManifestTrustBoundarySchema = z.enum(AGENT_MANIFEST_TRUST_BOUNDARIES);
export type AgentManifestTrustBoundary = z.infer<typeof agentManifestTrustBoundarySchema>;

export const agentManifestMcpServerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  status: z.enum(["available", "future", "unavailable"]),
  required: z.boolean().optional(),
  notes: z.string().optional(),
});
export type AgentManifestMcpServer = z.infer<typeof agentManifestMcpServerSchema>;

export const agentManifestSkillSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["anthropic-financial-services", "lingxia-local"]),
  pluginId: z.string().min(1),
  path: z.string().min(1),
  versionRef: z.string().min(1),
  notes: z.string().optional(),
});
export type AgentManifestSkill = z.infer<typeof agentManifestSkillSchema>;

export const agentManifestWorkerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  role: agentManifestRoleSchema,
  agentDefinitionId: z.string().min(1),
  profileRef: z.string().min(1),
  runtimeFamily: agentRuntimeFamilySchema,
  stageId: z.string().min(1).optional(),
  trustBoundary: agentManifestTrustBoundarySchema,
  consumesUntrustedInput: z.boolean().optional(),
  tools: z.array(agentManifestToolNameSchema),
  mcpServers: z.array(agentManifestMcpServerSchema),
  skills: z.array(agentManifestSkillSchema),
  outputSchemaRef: z.string().min(1).optional(),
  writeHolder: z.boolean().optional(),
  notes: z.string().optional(),
}).superRefine((worker, ctx) => {
  const hasWriteTool = worker.tools.some((tool) => tool === "write" || tool === "edit");
  if (hasWriteTool && worker.writeHolder !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["writeHolder"],
      message: "workers with write/edit tools must be marked as writeHolder",
    });
  }
  if (worker.writeHolder === true && worker.role !== "writer") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["role"],
      message: "only writer workers can be writeHolder",
    });
  }
  if (worker.trustBoundary === "untrusted_input_reader") {
    if (worker.skills.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skills"],
        message: "untrusted input readers must not receive runtime skills",
      });
    }
    if (worker.mcpServers.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcpServers"],
        message: "untrusted input readers must not receive MCP servers",
      });
    }
    if (worker.tools.some((tool) => tool === "write" || tool === "edit" || tool === "bash" || tool === "search")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tools"],
        message: "untrusted input readers are limited to read/grep/glob tools",
      });
    }
    if (!worker.outputSchemaRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputSchemaRef"],
        message: "untrusted input readers must declare an output schema reference",
      });
    }
  }
});
export type AgentManifestWorker = z.infer<typeof agentManifestWorkerSchema>;

export const agentManifestSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["draft", "active", "deprecated"]),
  displayName: z.string().min(1),
  shortDescription: z.string().min(1),
  runtimeSkillBundle: z.object({
    source: z.literal("anthropic-financial-services"),
    repo: z.string().url(),
    commit: z.string().min(7),
    runtimeRootRef: z.string().min(1),
    currentPath: z.string().min(1).optional(),
  }),
  upstreamCookbook: z.object({
    agentYamlPath: z.string().min(1),
    pluginPath: z.string().min(1),
    agentPromptPath: z.string().min(1),
  }),
  orchestrator: z.object({
    agentDefinitionId: z.string().min(1),
    profileRef: z.string().min(1),
    runtimeFamily: agentRuntimeFamilySchema,
    systemPromptRef: z.string().min(1),
    skills: z.array(agentManifestSkillSchema),
    mcpServers: z.array(agentManifestMcpServerSchema),
    tools: z.array(agentManifestToolNameSchema),
  }),
  workers: z.array(agentManifestWorkerSchema).min(1),
  createdAt: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
  updatedBy: z.number().int().positive().optional(),
}).superRefine((manifest, ctx) => {
  const workerIds = new Set<string>();
  for (const [index, worker] of manifest.workers.entries()) {
    if (workerIds.has(worker.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workers", index, "id"],
        message: `duplicate worker id: ${worker.id}`,
      });
    }
    workerIds.add(worker.id);
  }

  const writeHolders = manifest.workers.filter((worker) => worker.writeHolder === true);
  if (writeHolders.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workers"],
      message: "only one writeHolder worker is allowed per manifest",
    });
  }
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

export const agentManifestRegistrySeedSchema = z.object({
  manifests: z.array(agentManifestSchema).min(1),
});
export type AgentManifestRegistrySeed = z.infer<typeof agentManifestRegistrySeedSchema>;
