import { describe, expect, it } from "vitest";
import {
  agentManifestSchema,
  type AgentManifest,
} from "../../../../shared/types/agent-manifest";

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
