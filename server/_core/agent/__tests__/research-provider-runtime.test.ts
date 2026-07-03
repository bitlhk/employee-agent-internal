import { describe, expect, it, vi } from "vitest";
import {
  createResearchProvider,
  loadResearchRuntimeConfig,
  type ResearchRuntimeConfig,
} from "../research-provider-runtime";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function awsConfig(endpoint = "https://worker.example.test/search"): ResearchRuntimeConfig {
  return {
    planner: { mode: "lingxia-llm" },
    searchExecutor: { mode: "aws-worker", endpoint },
    evidenceGate: { mode: "lingxia" },
  };
}

describe("research provider runtime", () => {
  it("defaults to local search executor mode", () => {
    const config = loadResearchRuntimeConfig({});

    expect(config).toEqual({
      planner: { mode: "lingxia-llm", provider: undefined, model: undefined },
      searchExecutor: { mode: "local", endpoint: undefined },
      evidenceGate: { mode: "lingxia" },
    });
  });

  it("keeps local SourceResearchProvider behavior unchanged by default", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{
        title: "Sequoia Ascent 2026 source",
        url: "https://karpathy.bearblog.dev/sequoia-ascent-2026/",
        content: "Karpathy Sequoia Ascent 2026 notes",
        score: 0.95,
      }],
    })) as unknown as typeof fetch;
    const provider = createResearchProvider({
      planner: { mode: "deterministic" },
      searchExecutor: { mode: "local" },
      evidenceGate: { mode: "lingxia" },
    }, {
      env: { TAVILY_API_KEY: "tavily-secret" },
      fetchImpl,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    const result = await provider.research("Sequoia AI Ascent 2026");

    expect(fetchImpl).toHaveBeenCalledWith("https://api.tavily.com/search", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer tavily-secret" }),
    }));
    expect(result.candidates[0]).toMatchObject({
      provider: "tavily",
      publisherClass: "speaker_original",
      evidenceRole: "source_of_record",
    });
  });

  it("aws-worker receives only SearchPlan and platform still applies EvidenceGate", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{
        title: "Tencent report on Sequoia AI Ascent 2026",
        url: "https://news.qq.com/rain/a/20260430A01L1K00",
        snippet: "Sequoia AI Ascent 2026 conference takeaways",
        provider: "tavily",
        tags: ["ai"],
      }],
    })) as unknown as typeof fetch;
    const provider = createResearchProvider(awsConfig(), {
      fetchImpl,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    const result = await provider.research("Sequoia AI Ascent 2026");
    const body = JSON.parse(String((fetchImpl as any).mock.calls[0][1].body));

    expect((fetchImpl as any).mock.calls[0][0]).toBe("https://worker.example.test/search");
    expect(Object.keys(body).sort()).toEqual([
      "maxCandidates",
      "maxSearches",
      "normalizedQuery",
      "officialSourceHints",
      "planner",
      "queries",
      "rationale",
      "requiresSourceOfRecordHunt",
      "warnings",
    ]);
    expect(JSON.stringify(body)).not.toContain("sourceScore");
    expect(JSON.stringify(body)).not.toContain("evidenceSummary");
    expect(result.candidates[0]).toMatchObject({
      publisherClass: "reputable_media",
      topicFit: "exact_event",
      evidenceRole: "corroboration",
      tier: "secondary",
    });
  });

  it("keeps EvidencePacket shape stable for aws-worker results", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{
      title: "Sequoia Ascent 2026 summary",
      url: "https://karpathy.bearblog.dev/sequoia-ascent-2026/",
      snippet: "Karpathy Sequoia Ascent 2026 notes",
      provider: "brave",
      credibility: "unknown",
      language: "en",
      tags: ["ai"],
      score: 0.9,
    }])) as unknown as typeof fetch;
    const provider = createResearchProvider(awsConfig(), {
      fetchImpl,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    const result = await provider.research("Sequoia AI Ascent 2026 Karpathy");

    expect(result).toMatchObject({
      topic: "Sequoia AI Ascent 2026 Karpathy",
      generatedAt: "2026-05-05T00:00:00.000Z",
      candidates: [expect.objectContaining({
        sourceId: "src_001",
        publisherClass: "speaker_original",
        evidenceRole: "source_of_record",
      })],
      evidenceSummary: expect.objectContaining({
        primaryCount: 1,
        sourceOfRecordCount: 1,
      }),
      confidence: "medium",
    });
  });

  it("uses lingxia LLM planner output before deterministic queries", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{
        title: "Sequoia official AI Ascent page",
        url: "https://sequoiacap.com/article/ai-ascent-2026/",
        content: "Sequoia AI Ascent 2026 official event notes",
        score: 0.98,
      }],
    })) as unknown as typeof fetch;
    const callLlm = vi.fn(async () => ({
      content: JSON.stringify({
        queries: ["site:sequoiacap.com \"AI Ascent 2026\"", "Sequoia AI Ascent 2026 keynote"],
        officialSourceHints: ["sequoiacap.com", "karpathy.bearblog.dev"],
        rationale: "优先检索红杉官方和演讲者原文，再补媒体交叉验证。",
      }),
      provider: "zhipu" as const,
      model: "glm-test",
    }));
    const { PlatformLlmSearchPlanner } = await import("../research-provider-runtime");
    const provider = createResearchProvider({
      planner: { mode: "deterministic" },
      searchExecutor: { mode: "local" },
      evidenceGate: { mode: "lingxia" },
    }, {
      env: { TAVILY_API_KEY: "tavily-secret" },
      fetchImpl,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
      searchPlanner: new PlatformLlmSearchPlanner({
        env: { ZHIPU_API_KEY: "zhipu-secret" },
        provider: "zhipu",
        callLlm,
      }),
    });

    const result = await provider.research("红杉资本 2026 AI Ascent 大会的新观点");
    const firstBody = JSON.parse(String((fetchImpl as any).mock.calls[0][1].body));

    expect(firstBody.query).toBe("site:karpathy.bearblog.dev \"Sequoia Ascent 2026\"");
    expect(result.searchPlan?.queries).toEqual(expect.arrayContaining([
      "site:sequoiacap.com \"AI Ascent 2026\"",
    ]));
    expect(result.searchPlan).toMatchObject({
      planner: { mode: "lingxia-llm", provider: "zhipu", model: "glm-test" },
      officialSourceHints: ["sequoiacap.com", "karpathy.bearblog.dev"],
      rationale: "优先检索红杉官方和演讲者原文，再补媒体交叉验证。",
    });
    const plannerPrompt = JSON.stringify((callLlm as any).mock.calls[0][0].messages);
    expect(plannerPrompt).toContain("当前日期");
    expect(plannerPrompt).toContain("显式写了年份");
  });

  it("uses lingxia LLM source judge for semantic relevance only", async () => {
    const callLlm = vi.fn(async () => ({
      content: JSON.stringify({
        decisions: [{
          id: "src-a",
          semanticRelevance: "high",
          usefulness: "core",
          whyUseful: "direct event source candidate",
        }],
      }),
      provider: "deepseek" as const,
      model: "deepseek-test",
    }));
    const { PlatformLlmSourceJudge } = await import("../research-provider-runtime");
    const judge = new PlatformLlmSourceJudge({
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      provider: "deepseek",
      callLlm,
    });

    const normalizedQuery = {
      rawQuery: "Sequoia AI Ascent 2026",
      canonicalQuery: "Sequoia AI Ascent 2026",
      aliases: [],
      corrections: [],
    };
    const decisions = await judge.judge({
      topic: "Sequoia AI Ascent 2026",
      normalizedQuery,
      searchPlan: {
        normalizedQuery,
        queries: ["site:sequoiacap.com AI Ascent 2026"],
        maxSearches: 8,
        maxCandidates: 20,
        requiresSourceOfRecordHunt: true,
        planner: { mode: "lingxia-llm", provider: "deepseek", model: "deepseek-test" },
      },
      candidates: [{
        id: "src-a",
        title: "Sequoia AI Ascent 2026",
        url: "https://sequoiacap.com/article/ai-ascent-2026/",
        snippet: "Official event notes",
        provider: "tavily",
        credibility: "unknown",
        tags: ["ai"],
      }],
    });

    expect(decisions).toEqual([expect.objectContaining({
      id: "src-a",
      semanticRelevance: "high",
      usefulness: "core",
    })]);
    const prompt = JSON.stringify((callLlm as any).mock.calls[0][0].messages);
    expect(prompt).toContain("Do not decide evidenceRole");
    expect(prompt).toContain("Respect explicit years strictly");
  });

  it("requires an endpoint for aws-worker mode", () => {
    expect(() => createResearchProvider({
      planner: { mode: "lingxia-llm" },
      searchExecutor: { mode: "aws-worker" },
      evidenceGate: { mode: "lingxia" },
    })).toThrow("aws-worker search executor requires AGENT_RESEARCH_AWS_WORKER_URL");
  });

  it("keeps openclaw-tool as an explicit not-implemented executor", async () => {
    const provider = createResearchProvider({
      planner: { mode: "lingxia-llm" },
      searchExecutor: { mode: "openclaw-tool" },
      evidenceGate: { mode: "lingxia" },
    }, {
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    const result = await provider.research("AI trend report");

    expect(result.candidates).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "search executor failed: openclaw-tool search executor is not implemented yet",
    ]));
  });
});
