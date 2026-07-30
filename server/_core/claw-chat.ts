import express from "express";
import { existsSync } from "fs";
import path from "path";
import { clawChatLimiter } from "./security";
import {
  appendLogAsync,
  isAuthorizedInternalRequest,
  requireClawOwner,
} from "./helpers";
import { normalizeClientRunId } from "./chat-inflight";
import { isActiveJiuwenAdoptId, retiredRuntimeMessage } from "./runtime-policy";
import { listSkillsWithRoleDefaults } from "./skills/role-default-skills";
import { probeJiuwenSkillMcpReadiness } from "./skill-mcp-readiness";
import { capacityGuard } from "./operational-capacity";
import { beginChatRequest, beginRuntimeCall, type ChatOutcome } from "./observability/metrics";

type ChatRuntimeMode = "fast" | "plan";

const MAX_SELECTED_SKILLS = 3;

type SelectedSkillsContext =
  | {
      ok: true;
      message: string;
      skillIds: string[];
      labels: string[];
      skillFiles: string[];
      metadata: SelectedRuntimeSkill[];
    }
  | { ok: false; status: number; error: string };

export type SelectedRuntimeSkill = {
  id: string;
  name: string;
  description?: string;
  skillFile: string;
  runtimePath: string;
  sourceKind?: string;
  version?: string;
};

function normalizeSelectedSkillId(value: unknown): string {
  const skillId = String(value || "").trim();
  if (!skillId) return "";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(skillId)) return "";
  return skillId;
}

export function normalizeSelectedSkillIds(
  selectedSkillIds: unknown,
  legacySelectedSkillId?: unknown,
): { ok: true; skillIds: string[] } | { ok: false; error: string } {
  const rawValues = Array.isArray(selectedSkillIds)
    ? selectedSkillIds
    : legacySelectedSkillId == null
      ? []
      : [legacySelectedSkillId];
  if (rawValues.length > MAX_SELECTED_SKILLS) {
    return { ok: false, error: `每轮最多选择 ${MAX_SELECTED_SKILLS} 个技能` };
  }

  const skillIds: string[] = [];
  for (const rawValue of rawValues) {
    const rawSkillId = String(rawValue || "").trim();
    if (!rawSkillId) continue;
    const skillId = normalizeSelectedSkillId(rawSkillId);
    if (!skillId) return { ok: false, error: "所选技能标识无效" };
    if (!skillIds.includes(skillId)) skillIds.push(skillId);
  }
  return { ok: true, skillIds };
}

export function buildSelectedSkillsManifest(
  skills: SelectedRuntimeSkill[],
  userMessage: string,
): string {
  const skillLines = skills.flatMap((skill, index) => [
    `${index + 1}. selectedSkillId: ${skill.id}`,
    `   selectedSkillName: ${skill.name}`,
    skill.description
      ? `   selectedSkillDescription: ${skill.description.slice(0, 300)}`
      : "",
    `   selectedSkillFile: ${skill.skillFile}`,
  ]).filter(Boolean);
  return [
    "【本轮已由用户在输入框选择技能 Chip】",
    `selectedSkillCount: ${skills.length}`,
    ...skillLines,
    "要求：本轮优先使用用户选择的技能；根据用户目标决定组合方式和执行顺序，不要搜索或安装外部技能。",
    "请按需加载各 selectedSkillFile 对应的 SKILL.md，并只在需要时读取相关 references/scripts/examples；不要一次性加载无关材料。",
    "如果用户输入已经足够启动技能，请直接进入执行流程；如果缺少必要参数，再简短追问。",
    "",
    `用户问题：${userMessage}`,
  ].join("\n");
}

async function buildSelectedSkillsContext(
  adoptId: string,
  agentId: string,
  roleTemplate: string,
  selectedSkillIds: string[],
  userMessage: string,
): Promise<SelectedSkillsContext | null> {
  if (selectedSkillIds.length === 0) return null;

  const listed = await listSkillsWithRoleDefaults({ adoptId, agentId, roleTemplate });
  if (!listed.ok) {
    return { ok: false, status: 400, error: `技能读取失败：${listed.error.detail}` };
  }

  const metadata: SelectedRuntimeSkill[] = [];
  for (const skillId of selectedSkillIds) {
    const skill = listed.value.find((item: any) => String(item?.id || "") === skillId);
    if (!skill) {
      return {
        ok: false,
        status: 404,
        error: `所选技能“${skillId}”不存在或不属于当前智能体`,
      };
    }
    const label = String(
      (skill as any)?.source?.displayName
        || (skill as any)?.displayName
        || (skill as any)?.label
        || skillId,
    ).trim() || skillId;
    if (!skill.enabled || skill.state !== "ready") {
      return { ok: false, status: 400, error: `技能“${label}”未启用或尚未就绪` };
    }

    const runtimePath = String((skill as any)?.sync?.runtimePath || "").trim();
    if (!runtimePath) {
      return { ok: false, status: 400, error: `技能“${label}”尚未同步到运行时` };
    }
    const skillFile = path.join(runtimePath, "SKILL.md");
    if (!existsSync(skillFile)) {
      return { ok: false, status: 400, error: `技能“${label}”的运行时文件不存在` };
    }

    const description = String(
      (skill as any)?.source?.description || (skill as any)?.description || "",
    ).trim();
    metadata.push({
      id: skillId,
      name: label,
      ...(description ? { description: description.slice(0, 500) } : {}),
      skillFile,
      runtimePath,
      sourceKind: String((skill as any)?.source?.kind || "").trim() || undefined,
      version: String((skill as any)?.source?.version || "").trim() || undefined,
    });
  }

  const readinessResults = await Promise.all(metadata.map(async (skill) => ({
    skill,
    readiness: await probeJiuwenSkillMcpReadiness({
      adoptId,
      skillId: skill.id,
      roleTemplate,
    }),
  })));
  const unavailable = readinessResults.find((item) => !item.readiness.canProceed);
  if (unavailable) {
    return {
      ok: false,
      status: 503,
      error: `技能“${unavailable.skill.name}”：${unavailable.readiness.message}`,
    };
  }

  return {
    ok: true,
    message: buildSelectedSkillsManifest(metadata, userMessage),
    skillIds: metadata.map((skill) => skill.id),
    labels: metadata.map((skill) => skill.name),
    skillFiles: metadata.map((skill) => skill.skillFile),
    metadata,
  };
}

function normalizeChatRuntimeMode(value: unknown): ChatRuntimeMode {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : "fast";
}

async function resolveChatAdoption(
  req: express.Request,
  res: express.Response,
  adoptId: string,
) {
  if (isAuthorizedInternalRequest(req)) {
    const { getClawByAdoptId } = await import("../db");
    const adoption = await getClawByAdoptId(adoptId);
    if (!adoption) res.status(404).json({ error: "NOT_FOUND" });
    return adoption;
  }
  return requireClawOwner(req, res, adoptId);
}

export function registerChatStreamRoutes(app: express.Express) {
  app.post("/api/claw/jiuwen/permission-answer", clawChatLimiter, async (req, res) => {
    const {
      adoptId,
      requestId,
      action,
      selectedOption,
      source,
      channel,
      conversationId,
      epochLabel,
      runtimeMode,
    } = req.body || {};
    if (!adoptId || !requestId) {
      res.status(400).json({ error: "adoptId and requestId required" });
      return;
    }
    if (!isActiveJiuwenAdoptId(adoptId)) {
      res.status(410).json({ error: "RUNTIME_RETIRED", message: retiredRuntimeMessage() });
      return;
    }

    const adoption = await resolveChatAdoption(req, res, String(adoptId));
    if (!adoption) return;

    const normalizedAction = String(action || selectedOption || "").trim();
    const answerLabel =
      normalizedAction === "allow_once"
        || normalizedAction === "approve"
        || normalizedAction === "本次允许"
        ? "本次允许"
        : normalizedAction === "allow_always" || normalizedAction === "总是允许"
          ? "总是允许"
          : "拒绝";

    const { answerJiuwenPermission } = await import("./jiuwenclaw-bridge");
    const result = await answerJiuwenPermission(
      {
        adoptId: String(adoption.adoptId),
        agentId: String(adoption.agentId || `jiuwen_${String(adoption.adoptId)}`),
        userId: Number(adoption.userId),
      },
      {
        permissionRequestId: String(requestId),
        selectedOption: answerLabel,
        source: String(source || "permission_interrupt"),
        channel,
        conversationId,
        epochLabel,
        runtimeMode: normalizeChatRuntimeMode(runtimeMode),
      },
    );

    if (!result.ok) {
      res.status(502).json({ error: result.error, text: result.text || "" });
      return;
    }
    res.json({ ok: true, text: result.text || "", selectedOption: answerLabel });
  });

  app.post(
    "/api/claw/chat-stream",
    clawChatLimiter,
    capacityGuard("chat_http"),
    async (req, res) => {
      const {
        adoptId,
        message,
        model,
        epochLabel,
        channel,
        conversationId,
        runtimeMode,
        selectedSkillId,
        selectedSkillIds,
        knowledgeBaseIds,
        cancelPendingPermission,
      } = req.body || {};
      const clientRunId = normalizeClientRunId(req.body?.clientRunId);
      const normalizedRuntimeMode = normalizeChatRuntimeMode(runtimeMode);
      if (!adoptId || !message) {
        res.status(400).json({ error: "adoptId and message required" });
        return;
      }

      const adoption = await resolveChatAdoption(req, res, String(adoptId));
      if (!adoption) return;
      if (!isActiveJiuwenAdoptId(adoptId)) {
        res.status(410).json({ error: "RUNTIME_RETIRED", message: retiredRuntimeMessage() });
        return;
      }

      const chatMetric = beginChatRequest("jiuwenswarm");
      const runtimeMetric = beginRuntimeCall("jiuwenswarm");
      let metricFinished = false;
      const finishMetrics = (outcome: ChatOutcome) => {
        if (metricFinished) return;
        metricFinished = true;
        chatMetric.finish(outcome);
        runtimeMetric(outcome);
      };
      res.once("finish", () => finishMetrics(res.statusCode >= 400 ? "error" : "success"));
      res.once("close", () => finishMetrics(res.writableEnded ? "success" : "cancelled"));

      const userMessage = String(message || "").slice(0, 4000);
      if (!userMessage.trim()) {
        res.status(400).json({ error: "message is empty" });
        return;
      }
      const normalizedSelectedSkills = normalizeSelectedSkillIds(
        selectedSkillIds,
        selectedSkillId,
      );
      if (!normalizedSelectedSkills.ok) {
        res.status(400).json({ error: normalizedSelectedSkills.error });
        return;
      }

      const agentId = String(
        adoption.agentId || `jiuwen_${String(adoption.adoptId)}`,
      );
      const roleTemplate = String(adoption.roleTemplate || "general-assistant");
      const selectedSkills = await buildSelectedSkillsContext(
        String(adoption.adoptId),
        agentId,
        roleTemplate,
        normalizedSelectedSkills.skillIds,
        userMessage,
      );
      if (selectedSkills && !selectedSkills.ok) {
        res.status(selectedSkills.status).json({ error: selectedSkills.error });
        return;
      }

      const requestedModelId = String(model || "").trim();
      const {
        JIUWEN_AUTO_MODEL_ID,
        listSelectableJiuwenModels,
        resolveAutomaticSelectableJiuwenModel,
      } = await import("./jiuwenswarm-model-admin");
      let selectableModels;
      try {
        selectableModels = await listSelectableJiuwenModels();
      } catch {
        res.status(503).json({ error: "模型目录暂时不可用，请稍后重试" });
        return;
      }
      let selectedModel = requestedModelId === JIUWEN_AUTO_MODEL_ID
        ? resolveAutomaticSelectableJiuwenModel(selectableModels)
        : requestedModelId
          ? selectableModels.find((item) => item.id === requestedModelId)
          : undefined;
      if (requestedModelId && !selectedModel) {
        res.status(400).json({ error: "所选模型已不可用，请刷新模型列表后重试" });
        return;
      }
      if (!selectedModel) {
        const { getClawProfileSettings } = await import("../db");
        const settings = await getClawProfileSettings(Number(adoption.id));
        const preferredModelId = String((settings as any)?.model || "").trim();
        selectedModel = preferredModelId === JIUWEN_AUTO_MODEL_ID
          ? resolveAutomaticSelectableJiuwenModel(selectableModels)
          : selectableModels.find((item) => item.id === preferredModelId);
        selectedModel ||= resolveAutomaticSelectableJiuwenModel(selectableModels);
      }
      if (!selectedModel) {
        res.status(503).json({ error: "尚未配置可用的 Agent 模型" });
        return;
      }

      const selectedSkillMessageLimit = Math.max(
        4000,
        Number(process.env.SELECTED_SKILL_MESSAGE_MAX_CHARS || 8000) || 8000,
      );
      const runtimeMessageBody = selectedSkills?.ok
        ? selectedSkills.message.slice(0, selectedSkillMessageLimit)
        : userMessage;
      let knowledgeContext = "";
      let knowledgeSources: Array<Record<string, unknown>> = [];
      const manualKnowledgeSelection = Array.isArray(knowledgeBaseIds)
        && knowledgeBaseIds.length > 0;
      const knowledgeStartedAt = Date.now();
      try {
        const {
          buildChatKnowledgeContext,
          knowledgeRetrievalQuery,
          publicChatKnowledgeSources,
        } = await import("./knowledge-context");
        const knowledge = await buildChatKnowledgeContext({
          userId: Number(adoption.userId),
          roleTemplate,
          requestedIds: knowledgeBaseIds,
          query: knowledgeRetrievalQuery(userMessage),
        });
        knowledgeContext = knowledge.context;
        knowledgeSources = publicChatKnowledgeSources(knowledge.sources);
        appendLogAsync("jiuwenclaw-exec.log", {
          ts: new Date().toISOString(),
          event: "knowledge_retrieval",
          adoptId: String(adoption.adoptId),
          userId: Number(adoption.userId),
          clientRunId,
          mode: knowledge.mode,
          retrieval: knowledge.retrieval,
          candidateBaseCount: knowledge.candidateBaseCount,
          sourceCount: knowledgeSources.length,
          triggered: Boolean(knowledgeContext),
          retrievalMs: Date.now() - knowledgeStartedAt,
          bm25MaxScore: knowledge.metrics.bm25MaxScore,
          vectorMinDistance: knowledge.metrics.vectorMinDistance,
          queryCount: knowledge.metrics.queryCount,
          queryExpansion: knowledge.metrics.queryExpansion,
          reranker: knowledge.metrics.reranker,
        });
      } catch (error) {
        appendLogAsync("jiuwenclaw-exec.log", {
          ts: new Date().toISOString(),
          event: "knowledge_retrieval_failed",
          adoptId: String(adoption.adoptId),
          userId: Number(adoption.userId),
          clientRunId,
          mode: manualKnowledgeSelection ? "manual" : "auto",
          retrievalMs: Date.now() - knowledgeStartedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (manualKnowledgeSelection) {
          res.status(503).json({
            error: "知识检索暂时不可用，请稍后重试或取消选择知识库",
          });
          return;
        }
      }

      if (selectedSkills?.ok) {
        appendLogAsync("jiuwenclaw-exec.log", {
          ts: new Date().toISOString(),
          event: "selected_skills_injected",
          adoptId: String(adoption.adoptId),
          agentId,
          userId: Number(adoption.userId),
          clientRunId,
          selectedSkillIds: selectedSkills.skillIds,
          selectedSkillNames: selectedSkills.labels,
          selectedSkillFiles: selectedSkills.skillFiles,
          model: selectedModel.runtimeModelId,
          injectionMode: "manifest",
        });
      }

      const runtimeMessage = knowledgeContext
        ? `${knowledgeContext}\n\n<user_request>\n${runtimeMessageBody}\n</user_request>`
        : runtimeMessageBody;
      const { forwardToJiuwenClaw } = await import("./jiuwenclaw-bridge");
      await forwardToJiuwenClaw(
        {
          adoptId: String(adoption.adoptId),
          agentId,
          userId: Number(adoption.userId),
          roleTemplate,
        },
        runtimeMessage,
        res,
        {
          model: selectedModel.runtimeModelId,
          req,
          channel,
          conversationId,
          epochLabel,
          clientRunId,
          runtimeMode: normalizedRuntimeMode,
          cancelPendingPermission,
          selectedSkills: selectedSkills?.ok ? selectedSkills.metadata : [],
          knowledgeSources,
          memoryUserMessage: userMessage,
          onFirstToken: chatMetric.observeFirstToken,
        },
      );
    },
  );
}
