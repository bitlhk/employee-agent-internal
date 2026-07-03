import {
  createDeterministicSearchPlan,
  SourceResearchProvider,
  type InsightCredibility,
  type InsightSearchProvider,
  type NormalizedSearchResult,
  type SearchExecutor,
  type SearchPlanner,
  type SearchPlannerInput,
  type SearchPlan,
  type SourceJudge,
  type SourceJudgeDecision,
  type SourceJudgeInput,
  type SourceResearchFetch,
  type SourceResearchOptions,
} from "./source-research-provider";
import { callLLM, type LLMProvider } from "../llm-provider";

export type ResearchPlannerMode = "deterministic" | "lingxia-llm";
export type SearchExecutorMode = "local" | "aws-worker" | "openclaw-tool";
export type EvidenceGateMode = "lingxia";

export type ResearchRuntimeConfig = {
  planner: {
    mode: ResearchPlannerMode;
    provider?: LLMProvider;
    model?: string;
  };
  searchExecutor: {
    mode: SearchExecutorMode;
    endpoint?: string;
  };
  evidenceGate: {
    mode: EvidenceGateMode;
  };
};

type RuntimeEnv = Record<string, string | undefined>;

function parseMode<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  return allowed.includes(value as T) ? value as T : fallback;
}

export function loadResearchRuntimeConfig(env: RuntimeEnv = process.env): ResearchRuntimeConfig {
  return {
    planner: {
      mode: parseMode(env.AGENT_RESEARCH_PLANNER_MODE || env.RESEARCH_PLANNER_MODE, ["deterministic", "lingxia-llm"], "lingxia-llm"),
      provider: parseLlmProvider(env.AGENT_RESEARCH_LLM_PROVIDER || env.RESEARCH_LLM_PROVIDER),
      model: env.AGENT_RESEARCH_LLM_MODEL || env.RESEARCH_LLM_MODEL,
    },
    searchExecutor: {
      mode: parseMode(
        env.AGENT_RESEARCH_SEARCH_EXECUTOR_MODE || env.RESEARCH_SEARCH_EXECUTOR_MODE,
        ["local", "aws-worker", "openclaw-tool"],
        "local",
      ),
      endpoint: env.AGENT_RESEARCH_AWS_WORKER_URL || env.RESEARCH_AWS_WORKER_URL,
    },
    evidenceGate: {
      mode: parseMode(env.AGENT_RESEARCH_EVIDENCE_GATE_MODE || env.RESEARCH_EVIDENCE_GATE_MODE, ["lingxia"], "lingxia"),
    },
  };
}

function parseLlmProvider(value: string | undefined): LLMProvider | undefined {
  return value === "zhipu" || value === "deepseek" ? value : undefined;
}

function assertPlatformEvidenceGate(config: ResearchRuntimeConfig) {
  if (config.evidenceGate.mode !== "lingxia") {
    throw new Error(`unsupported evidence gate mode: ${config.evidenceGate.mode}`);
  }
}

function searchPlanPayload(plan: SearchPlan) {
  return {
    normalizedQuery: plan.normalizedQuery,
    queries: plan.queries,
    maxSearches: plan.maxSearches,
    maxCandidates: plan.maxCandidates,
    requiresSourceOfRecordHunt: plan.requiresSourceOfRecordHunt,
    planner: plan.planner,
    rationale: plan.rationale,
    officialSourceHints: plan.officialSourceHints,
    warnings: plan.warnings,
  };
}

function isSearchProvider(value: unknown): value is InsightSearchProvider {
  return value === "tavily" || value === "bocha" || value === "brave";
}

function isCredibility(value: unknown): value is InsightCredibility {
  return value === "official"
    || value === "primary"
    || value === "trusted_media"
    || value === "community"
    || value === "unknown";
}

function normalizeWorkerResult(value: any, index: number): NormalizedSearchResult {
  const provider = isSearchProvider(value?.provider) ? value.provider : "tavily";
  const url = String(value?.url || "");
  const title = String(value?.title || value?.name || url || "Untitled source");
  return {
    id: String(value?.id || `aws-worker:${index}:${url || title}`),
    title,
    url,
    sourceName: value?.sourceName ? String(value.sourceName) : value?.siteName ? String(value.siteName) : undefined,
    publishedAt: value?.publishedAt ? String(value.publishedAt) : undefined,
    snippet: value?.snippet ? String(value.snippet) : value?.summary ? String(value.summary) : undefined,
    provider,
    credibility: isCredibility(value?.credibility) ? value.credibility : "unknown",
    language: value?.language === "zh" || value?.language === "en" || value?.language === "unknown" ? value.language : "unknown",
    tags: Array.isArray(value?.tags) ? value.tags.map((tag: unknown) => String(tag)).filter(Boolean) : [],
    score: typeof value?.score === "number" ? value.score : undefined,
  };
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] || trimmed).trim();
}

function parsePlannerJson(value: string): any {
  const raw = stripCodeFence(value);
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("planner response is not valid JSON");
  }
}

function providerKey(env: RuntimeEnv, provider: LLMProvider): string | undefined {
  if (provider === "zhipu") return env.ZHIPU_API_KEY || env.BIGMODEL_API_KEY || env.GLM_API_KEY || process.env.ZHIPU_API_KEY || process.env.BIGMODEL_API_KEY || process.env.GLM_API_KEY;
  return env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;
}

function selectPlannerProvider(env: RuntimeEnv, requested?: LLMProvider): LLMProvider | undefined {
  if (requested && providerKey(env, requested)) return requested;
  if (providerKey(env, "zhipu")) return "zhipu";
  if (providerKey(env, "deepseek")) return "deepseek";
  return undefined;
}

function sourceJudgeEnabled(env: RuntimeEnv): boolean {
  const value = env.AGENT_RESEARCH_SOURCE_JUDGE_LLM || env.RESEARCH_SOURCE_JUDGE_LLM;
  return String(value || "true").toLowerCase() !== "false";
}

export class PlatformLlmSearchPlanner implements SearchPlanner {
  constructor(private readonly options: {
    env?: RuntimeEnv;
    provider?: LLMProvider;
    model?: string;
    callLlm?: typeof callLLM;
  } = {}) {}

  async plan(input: SearchPlannerInput): Promise<SearchPlan> {
    const fallback = createDeterministicSearchPlan(input);
    const env = this.options.env || process.env;
    const provider = selectPlannerProvider(env, this.options.provider);
    if (!provider) {
      return {
        ...fallback,
        warnings: ["LLM search planner disabled: missing zhipu/deepseek API key"],
      };
    }
    const call = this.options.callLlm || callLLM;
    const response = await call({
      provider,
      modelOverride: this.options.model,
      maxTokens: 900,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            "你是企业研究系统的搜索规划器，只输出 JSON。",
            "目标是把用户研究需求改写成高质量搜索计划，优先官方来源、一手演讲、speaker 原文、会议页面。",
            "不要判断来源可信度；可信度由后续 EvidenceGate 规则裁决。",
            `当前日期是 ${new Date().toISOString().slice(0, 10)}。用户说“最新/最近/今年”时，默认围绕当前年份和最近公开材料，不要无依据退回旧年份。`,
            "如果用户显式写了年份（包括 Ascent2026 这种紧贴实体的写法），queries 必须保留该年份，不要替换为其他年份。",
            "queries 最多 8 条，必须包含中英文组合；如是会议/发布会/模型事件，至少 2 条官方/source-of-record hunt 查询。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            rawQuery: input.normalizedQuery.rawQuery,
            canonicalQuery: input.normalizedQuery.canonicalQuery,
            deterministicQueries: fallback.queries,
            maxQueries: input.maxSearches,
            requiresSourceOfRecordHunt: input.requiresSourceOfRecordHunt,
            outputSchema: {
              queries: ["string"],
              officialSourceHints: ["string"],
              rationale: "string, <=120 Chinese chars",
            },
          }),
        },
      ],
    });
    const parsed = parsePlannerJson(response.content);
    const llmQueries = Array.isArray(parsed?.queries) ? parsed.queries.map((item: unknown) => String(item).trim()).filter(Boolean) : [];
    const officialSourceHints = Array.isArray(parsed?.officialSourceHints)
      ? parsed.officialSourceHints.map((item: unknown) => String(item).trim()).filter(Boolean)
      : [];
    const mergedQueries = Array.from(new Set([
      ...llmQueries,
      ...fallback.queries,
    ])).slice(0, input.maxSearches);
    return {
      ...fallback,
      queries: mergedQueries.length ? mergedQueries : fallback.queries,
      planner: { mode: "lingxia-llm", provider, model: response.model },
      rationale: typeof parsed?.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim().slice(0, 180)
        : "LLM 将用户需求改写为中英文多路搜索，并保留规则生成的官方源 hunt 查询。",
      officialSourceHints,
    };
  }
}

export class PlatformLlmSourceJudge implements SourceJudge {
  constructor(private readonly options: {
    env?: RuntimeEnv;
    provider?: LLMProvider;
    model?: string;
    callLlm?: typeof callLLM;
  } = {}) {}

  async judge(input: SourceJudgeInput): Promise<SourceJudgeDecision[]> {
    const env = this.options.env || process.env;
    const provider = selectPlannerProvider(env, this.options.provider);
    if (!provider) return [];
    const call = this.options.callLlm || callLLM;
    const candidates = input.candidates.slice(0, 24).map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      url: candidate.url,
      sourceName: candidate.sourceName,
      publishedAt: candidate.publishedAt,
      snippet: candidate.snippet,
      provider: candidate.provider,
      credibility: candidate.credibility,
    }));
    const response = await call({
      provider,
      modelOverride: this.options.model,
      maxTokens: 1200,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are the Source Judge for an enterprise research system. Output JSON only.",
            "Judge only semantic relevance, practical usefulness, and likely noise for each candidate source.",
            "Do not decide evidenceRole, source_of_record, corroboration, or confidence. EvidenceGate will make those final decisions.",
            "Respect explicit years strictly. If the user asks for 2026, a 2025 event page is usually low relevance or context unless it is clearly requested for historical comparison.",
            "Allowed semanticRelevance values: high, medium, low.",
            "Allowed usefulness values: core, support, context, noise.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            topic: input.topic,
            canonicalQuery: input.normalizedQuery.canonicalQuery,
            aliases: input.normalizedQuery.aliases,
            searchPlan: {
              queries: input.searchPlan.queries,
              sourceHunt: input.searchPlan.sourceHunt,
              officialSourceHints: input.searchPlan.officialSourceHints,
            },
            candidates,
            outputSchema: {
              decisions: [{
                id: "candidate id",
                semanticRelevance: "high | medium | low",
                usefulness: "core | support | context | noise",
                whyUseful: "short reason, <=80 Chinese chars",
                noiseReason: "only when usefulness=noise",
              }],
            },
          }),
        },
      ],
    });
    const parsed = parsePlannerJson(response.content);
    const rawDecisions = Array.isArray(parsed?.decisions)
      ? parsed.decisions
      : Array.isArray(parsed) ? parsed : [];
    return rawDecisions
      .map((decision: any): SourceJudgeDecision | undefined => {
        const semanticRelevance = decision?.semanticRelevance;
        const usefulness = decision?.usefulness;
        if (!["high", "medium", "low"].includes(semanticRelevance)) return undefined;
        if (!["core", "support", "context", "noise"].includes(usefulness)) return undefined;
        const id = typeof decision?.id === "string" ? decision.id : undefined;
        const url = typeof decision?.url === "string" ? decision.url : undefined;
        if (!id && !url) return undefined;
        return {
          id,
          url,
          semanticRelevance,
          usefulness,
          whyUseful: typeof decision?.whyUseful === "string" ? decision.whyUseful.slice(0, 240) : undefined,
          noiseReason: typeof decision?.noiseReason === "string" ? decision.noiseReason.slice(0, 240) : undefined,
        };
      })
      .filter((decision: SourceJudgeDecision | undefined): decision is SourceJudgeDecision => Boolean(decision));
  }
}

export class AwsWorkerSearchExecutor implements SearchExecutor {
  constructor(private readonly options: {
    endpoint: string;
    fetchImpl?: SourceResearchFetch;
  }) {}

  async search(plan: SearchPlan): Promise<NormalizedSearchResult[]> {
    const fetchImpl = this.options.fetchImpl || fetch;
    const response = await fetchImpl(this.options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(searchPlanPayload(plan)),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(`aws-worker search failed: http_${response.status}`);
    }
    const values = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.results) ? payload.results
      : Array.isArray(payload?.candidates) ? payload.candidates
      : [];
    return values.map(normalizeWorkerResult);
  }
}

export class OpenClawToolSearchExecutor implements SearchExecutor {
  async search(): Promise<NormalizedSearchResult[]> {
    throw new Error("openclaw-tool search executor is not implemented yet");
  }
}

export function createResearchProvider(
  config: ResearchRuntimeConfig = loadResearchRuntimeConfig(),
  options: Omit<SourceResearchOptions, "searchExecutor"> = {},
): SourceResearchProvider {
  assertPlatformEvidenceGate(config);
  const configuredSearchPlanner = config.planner.mode === "lingxia-llm"
    ? new PlatformLlmSearchPlanner({
      env: options.env,
      provider: config.planner.provider,
      model: config.planner.model,
    })
    : undefined;
  const searchPlanner = configuredSearchPlanner || options.searchPlanner;
  const configuredSourceJudge = config.planner.mode === "lingxia-llm" && sourceJudgeEnabled(options.env || process.env)
    ? new PlatformLlmSourceJudge({
      env: options.env,
      provider: config.planner.provider,
      model: config.planner.model,
    })
    : undefined;
  const sourceJudge = options.sourceJudge || configuredSourceJudge;
  if (config.searchExecutor.mode === "local") {
    return new SourceResearchProvider({ ...options, searchPlanner, sourceJudge });
  }
  if (config.searchExecutor.mode === "aws-worker") {
    if (!config.searchExecutor.endpoint) {
      throw new Error("aws-worker search executor requires AGENT_RESEARCH_AWS_WORKER_URL");
    }
    return new SourceResearchProvider({
      ...options,
      searchPlanner,
      sourceJudge,
      searchExecutor: new AwsWorkerSearchExecutor({
        endpoint: config.searchExecutor.endpoint,
        fetchImpl: options.fetchImpl,
      }),
    });
  }
  return new SourceResearchProvider({
    ...options,
    searchPlanner,
    sourceJudge,
    searchExecutor: new OpenClawToolSearchExecutor(),
  });
}
