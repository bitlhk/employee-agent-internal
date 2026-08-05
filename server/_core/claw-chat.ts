import express from "express";
import { existsSync } from "fs";
import path from "path";
import { auditRequest, recordAuditBestEffort } from "./audit-events";
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
import {
  beginChatRequest,
  beginRuntimeCall,
  observeCapabilityPreflight,
  type ChatOutcome,
} from "./observability/metrics";
import { observePublicModelTraffic } from "./observability/public-health";
import {
  buildSelectedSkillsManifest,
  normalizeSelectedSkillIds,
  selectAutomaticSkillMatch,
  type SkillSelectionMode,
  type SelectedRuntimeSkill,
} from "./chat-selected-skills";
import { invalidateChatHistorySessionList } from "./chat-history";
import {
  PLATFORM_UNTRUSTED_CONTENT_POLICY,
  detectInstructionAttackSignals,
} from "./instruction-attack";
import { parseUploadedAttachmentRuntimeMessage } from "../../shared/uploaded-attachment-context";
import { summarizeCapabilityPreflight, type CapabilityPreflight } from "../../shared/capability-preflight";

type ChatRuntimeMode = "fast" | "plan";

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

async function buildSelectedSkillsContext(
  adoptId: string,
  agentId: string,
  roleTemplate: string,
  selectedSkillIds: string[],
  userMessage: string,
  selectionMode: SkillSelectionMode = "manual",
  listedSkills?: any[],
): Promise<SelectedSkillsContext | null> {
  if (selectedSkillIds.length === 0) return null;

  let skills = listedSkills;
  if (!skills) {
    const listed = await listSkillsWithRoleDefaults({ adoptId, agentId, roleTemplate });
    if (!listed.ok) {
      return { ok: false, status: 400, error: `技能读取失败：${listed.error.detail}` };
    }
    skills = listed.value;
  }

  const metadata: SelectedRuntimeSkill[] = [];
  for (const skillId of selectedSkillIds) {
    const skill = skills.find((item: any) => String(item?.id || "") === skillId);
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
  const preflightEntries: CapabilityPreflight[] = readinessResults.map(({ skill, readiness }) => ({
    kind: "skill",
    id: skill.id,
    name: skill.name,
    readiness: readiness.canProceed ? "ready" : "blocked",
    ...(!readiness.canProceed ? { reason: readiness.message } : {}),
  }));
  for (const entry of preflightEntries) {
    observeCapabilityPreflight({ kind: entry.kind, outcome: entry.readiness });
  }
  for (const { readiness } of readinessResults) {
    for (const server of readiness.servers) {
      const outcome = server.probeError
        ? "unchecked"
        : server.authorized && server.configured && server.enabled && server.missingTools.length === 0
          ? "ready"
          : "blocked";
      observeCapabilityPreflight({ kind: "connector", outcome });
    }
  }
  const preflight = summarizeCapabilityPreflight(preflightEntries);
  if (!preflight.ready) {
    const unavailable = preflight.blocked[0];
    return {
      ok: false,
      status: 503,
      error: `技能“${unavailable.name}”：${unavailable.reason || "暂时不可用"}`,
    };
  }

  return {
    ok: true,
    message: buildSelectedSkillsManifest(metadata, userMessage, selectionMode),
    skillIds: metadata.map((skill) => skill.id),
    labels: metadata.map((skill) => skill.name),
    skillFiles: metadata.map((skill) => skill.skillFile),
    metadata,
  };
}

function normalizeChatRuntimeMode(value: unknown): ChatRuntimeMode {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : "fast";
}

function normalizeInteractionAnswers(value: unknown): Array<{ selectedOptions: string[]; customInput: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => {
    const answer = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const rawSelected = Array.isArray(answer.selectedOptions)
      ? answer.selectedOptions
      : Array.isArray(answer.selected_options)
        ? answer.selected_options
        : [];
    const selectedOptions = rawSelected
      .map((option) => String(option || "").trim().slice(0, 160))
      .filter(Boolean)
      .slice(0, 12);
    const customInput = String(answer.customInput || answer.custom_input || "").trim().slice(0, 4000);
    return { selectedOptions, customInput };
  }).filter((answer) => answer.selectedOptions.length > 0 || Boolean(answer.customInput));
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
      answers,
      kind,
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

    const normalizedSource = String(source || "permission_interrupt").trim() || "permission_interrupt";
    const isQuestion = kind === "question" || normalizedSource === "ask_user_interrupt";
    const interactionAnswers = isQuestion ? normalizeInteractionAnswers(answers) : [];
    if (isQuestion && interactionAnswers.length === 0) {
      res.status(400).json({ error: "请先回答智能体提出的问题" });
      return;
    }
    const normalizedAction = String(action || selectedOption || "").trim();
    const answerLabel = isQuestion
      ? interactionAnswers[0]?.selectedOptions[0] || interactionAnswers[0]?.customInput || ""
      : normalizedAction === "allow_once"
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
        ...(interactionAnswers.length > 0 ? { answers: interactionAnswers } : {}),
        source: normalizedSource,
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
      invalidateChatHistorySessionList(String(adoptId));

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
      const instructionAttack = detectInstructionAttackSignals(userMessage);
      if (instructionAttack.detected) {
        await recordAuditBestEffort({
          category: "security",
          action: "security.instruction_attack.detected",
          result: "warning",
          severity: instructionAttack.severity,
          actorType: "user",
          actorUserId: Number(adoption.userId),
          ...auditRequest(req),
          targetType: "claw_adoption",
          targetId: String(adoption.adoptId),
          agentInstanceId: String(adoption.adoptId),
          runtimeType: "jiuwenswarm",
          runtimeAgentId: String(adoption.agentId || `jiuwen_${String(adoption.adoptId)}`),
          sessionId: String(conversationId || "").slice(0, 128) || null,
          correlationId: clientRunId,
          source: "chat_user_input",
          detailType: "instruction_attack_signal",
          policyCode: "EA_INSTRUCTION_ATTACK_MONITOR_V1",
          riskType: "prompt_injection",
          metadata: {
            contentSource: "user_input",
            ruleIds: instructionAttack.signals.map((signal) => signal.ruleId),
            categories: Array.from(new Set(instructionAttack.signals.map((signal) => signal.category))),
            fingerprint: instructionAttack.fingerprint,
            scannedChars: instructionAttack.scannedChars,
            blocked: false,
          },
        });
      }
      const normalizedSelectedSkills = normalizeSelectedSkillIds(
        selectedSkillIds,
        selectedSkillId,
      );
      if (!normalizedSelectedSkills.ok) {
        res.status(400).json({ error: normalizedSelectedSkills.error });
        return;
      }

      const parsedUserMessage = parseUploadedAttachmentRuntimeMessage(userMessage);
      const agentId = String(
        adoption.agentId || `jiuwen_${String(adoption.adoptId)}`,
      );
      const roleTemplate = String(adoption.roleTemplate || "general-assistant");
      let effectiveSkillIds = normalizedSelectedSkills.skillIds;
      let skillSelectionMode: SkillSelectionMode = "manual";
      let listedSkills: any[] | undefined;
      let automaticSkillMatch: ReturnType<typeof selectAutomaticSkillMatch> = null;
      if (effectiveSkillIds.length === 0) {
        const listed = await listSkillsWithRoleDefaults({ adoptId: String(adoption.adoptId), agentId, roleTemplate });
        if (listed.ok) {
          listedSkills = listed.value;
          automaticSkillMatch = selectAutomaticSkillMatch(listed.value, parsedUserMessage.text || userMessage);
          if (automaticSkillMatch) {
            effectiveSkillIds = [automaticSkillMatch.skillId];
            skillSelectionMode = "automatic";
          }
        }
      }
      let selectedSkills = await buildSelectedSkillsContext(
        String(adoption.adoptId),
        agentId,
        roleTemplate,
        effectiveSkillIds,
        userMessage,
        skillSelectionMode,
        listedSkills,
      );
      if (selectedSkills && !selectedSkills.ok) {
        if (skillSelectionMode === "manual") {
          res.status(selectedSkills.status).json({ error: selectedSkills.error });
          return;
        }
        appendLogAsync("jiuwenclaw-exec.log", {
          ts: new Date().toISOString(),
          event: "automatic_skill_skipped",
          adoptId: String(adoption.adoptId),
          agentId,
          userId: Number(adoption.userId),
          clientRunId,
          skillId: automaticSkillMatch?.skillId || "",
          reason: selectedSkills.error,
        });
        selectedSkills = null;
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
        observeCapabilityPreflight({ kind: "model", outcome: "blocked" });
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
        observeCapabilityPreflight({ kind: "model", outcome: "blocked" });
        res.status(503).json({ error: "尚未配置可用的 Agent 模型" });
        return;
      }
      observeCapabilityPreflight({ kind: "model", outcome: "ready" });

      const selectedSkillMessageLimit = Math.max(
        4000,
        Number(process.env.SELECTED_SKILL_MESSAGE_MAX_CHARS || 8000) || 8000,
      );
      const runtimeMessageBody = selectedSkills?.ok
        ? selectedSkills.message.slice(0, selectedSkillMessageLimit)
        : userMessage;
      let knowledgeContext = "";
      let memoryContext = "";
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
          bm25RelevantMaxScore: knowledge.metrics.bm25RelevantMaxScore,
          vectorMinDistance: knowledge.metrics.vectorMinDistance,
          queryCount: knowledge.metrics.queryCount,
          queryExpansion: knowledge.metrics.queryExpansion,
          reranker: knowledge.metrics.reranker,
          queryTermCount: knowledge.metrics.queryTermCount,
          lexicalMatchCount: knowledge.metrics.lexicalMatchCount,
          lexicalCoverage: knowledge.metrics.lexicalCoverage,
          autoGate: knowledge.metrics.autoGate,
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

      const memoryStartedAt = Date.now();
      try {
        const { buildRelevantAgentMemoryContext } = await import("./agent-memory-retrieval");
        const memory = await buildRelevantAgentMemoryContext({
          userId: Number(adoption.userId),
          adoptId: String(adoption.adoptId),
          adoptionId: Number(adoption.id),
          query: parsedUserMessage.text || userMessage,
        });
        memoryContext = memory.context;
        appendLogAsync("jiuwenclaw-exec.log", {
          ts: new Date().toISOString(),
          event: "memory_retrieval",
          adoptId: String(adoption.adoptId),
          userId: Number(adoption.userId),
          clientRunId,
          activeCount: memory.activeCount,
          selectedCount: memory.selectedIds.length,
          retrievalMs: Date.now() - memoryStartedAt,
        });
      } catch (error) {
        appendLogAsync("jiuwenclaw-exec.log", {
          ts: new Date().toISOString(),
          event: "memory_retrieval_failed",
          adoptId: String(adoption.adoptId),
          userId: Number(adoption.userId),
          clientRunId,
          retrievalMs: Date.now() - memoryStartedAt,
          error: error instanceof Error ? error.message : String(error),
        });
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
          injectionMode: skillSelectionMode === "automatic" ? "automatic_manifest" : "manifest",
          ...(automaticSkillMatch ? {
            matchScore: automaticSkillMatch.score,
            matchReason: automaticSkillMatch.reason,
          } : {}),
        });
      }

      const contextualMemory = [memoryContext, knowledgeContext].filter(Boolean).join("\n\n");
      const userScopedRuntimeMessage = contextualMemory
        ? `${contextualMemory}\n\n<user_request>\n${runtimeMessageBody}\n</user_request>`
        : runtimeMessageBody;
      const runtimeMessage = [
        "<ea_security_policy>",
        PLATFORM_UNTRUSTED_CONTENT_POLICY,
        "</ea_security_policy>",
        "",
        userScopedRuntimeMessage,
      ].join("\n");
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
          onRuntimeOutcome: observePublicModelTraffic,
        },
      );
    },
  );
}
