import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentManifestRegistrySeedSchema,
  agentManifestSchema,
  type AgentManifest,
} from "../../../../shared/types/agent-manifest";

function loadSeed() {
  const raw = readFileSync(resolve(process.cwd(), "server/_core/agent/data/agent-manifests.seed.json"), "utf8");
  return JSON.parse(raw);
}

function baseManifest(overrides: Partial<AgentManifest> = {}) {
  return {
    id: "test_manifest",
    version: 1,
    status: "draft",
    displayName: "Test Manifest",
    shortDescription: "Test manifest",
    runtimeSkillBundle: {
      source: "anthropic-financial-services",
      repo: "https://github.com/anthropics/financial-services",
      commit: "57772c3f1607229fba0270f94abf3c976bbd852f",
      runtimeRootRef: "HERMES_RUNTIME_SKILL_ROOT",
    },
    upstreamCookbook: {
      agentYamlPath: "managed-agent-cookbooks/test/agent.yaml",
      pluginPath: "plugins/agent-plugins/test",
      agentPromptPath: "plugins/agent-plugins/test/agents/test.md",
    },
    orchestrator: {
      agentDefinitionId: "financial-harness",
      profileRef: "financial-harness",
      runtimeFamily: "hermes",
      systemPromptRef: "plugins/agent-plugins/test/agents/test.md",
      skills: [],
      mcpServers: [],
      tools: ["read", "grep", "glob"],
    },
    workers: [
      {
        id: "test-reader",
        displayName: "检索员",
        role: "reader",
        agentDefinitionId: "test-reader",
        profileRef: "test-reader",
        runtimeFamily: "hermes",
        trustBoundary: "untrusted_input_reader",
        consumesUntrustedInput: true,
        tools: ["read", "grep"],
        mcpServers: [],
        skills: [],
        outputSchemaRef: "managed-agent-cookbooks/test/subagents/reader.yaml#output_schema",
      },
      {
        id: "test-writer",
        displayName: "写作员",
        role: "writer",
        agentDefinitionId: "test-writer",
        profileRef: "test-writer",
        runtimeFamily: "hermes",
        trustBoundary: "write_holder",
        tools: ["read", "write", "edit"],
        mcpServers: [],
        skills: [],
        writeHolder: true,
      },
    ],
    ...overrides,
  } satisfies AgentManifest;
}

describe("agent manifest schema", () => {
  it("validates the seed manifest registry", () => {
    const parsed = agentManifestRegistrySeedSchema.safeParse(loadSeed());

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.manifests.map((manifest) => manifest.id)).toEqual([
        "market_researcher",
        "meeting_prep_agent",
      ]);
    }
  });

  it("keeps Anthropic runtime skills scoped to the two pilot manifests", () => {
    const parsed = agentManifestRegistrySeedSchema.parse(loadSeed());
    const skillIds = new Set(parsed.manifests.flatMap((manifest) => [
      ...manifest.orchestrator.skills.map((skill) => `${skill.pluginId}/${skill.id}`),
      ...manifest.workers.flatMap((worker) => worker.skills.map((skill) => `${skill.pluginId}/${skill.id}`)),
    ]));

    expect(skillIds).toEqual(new Set([
      "market-researcher/sector-overview",
      "market-researcher/competitive-analysis",
      "market-researcher/comps-analysis",
      "market-researcher/idea-generation",
      "market-researcher/pptx-author",
      "meeting-prep-agent/client-report",
      "meeting-prep-agent/client-review",
      "meeting-prep-agent/investment-proposal",
      "meeting-prep-agent/pptx-author",
    ]));
  });

  it("requires untrusted readers to avoid skills, MCP, and write tools", () => {
    const manifest = baseManifest({
      workers: [
        {
          ...baseManifest().workers[0],
          skills: [{
            id: "comps-analysis",
            source: "anthropic-financial-services",
            pluginId: "market-researcher",
            path: "plugins/agent-plugins/market-researcher/skills/comps-analysis",
            versionRef: "57772c3f1607229fba0270f94abf3c976bbd852f",
          }],
        },
      ],
    });

    expect(agentManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("requires write/edit tools to be held by a writer write-holder", () => {
    const manifest = baseManifest({
      workers: [
        {
          ...baseManifest().workers[0],
          id: "bad-analyst",
          role: "analyst",
          trustBoundary: "trusted_data_access",
          outputSchemaRef: undefined,
          tools: ["read", "edit"],
        },
      ],
    });

    expect(agentManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("allows only one write-holder per manifest", () => {
    const first = baseManifest().workers[1];
    const manifest = baseManifest({
      workers: [
        first,
        {
          ...first,
          id: "second-writer",
          agentDefinitionId: "second-writer",
          profileRef: "second-writer",
        },
      ],
    });

    expect(agentManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
