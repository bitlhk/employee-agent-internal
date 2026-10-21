import type { Request, Response } from "express";
import { existsSync } from "fs";
import { WebSocket, type RawData } from "ws";
import path from "path";
import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";
import {
  buildJiuwenAgentId,
  buildJiuwenImageMediaItems,
  buildJiuwenRunDescriptor,
  buildJiuwenSessionId,
  buildJiuwenServiceId,
  bumpSessionEpoch,
  type JiuwenClawRuntimeClaw,
  type JiuwenForwardOptions,
  type JiuwenInteractionAnswer,
  type JiuwenPermissionRequest,
  type JiuwenSelectedSkillMetadata,
  normalizeJiuwenFileEvent,
  normalizeJiuwenPermissionRequest,
  normalizeJiuwenToolPayload,
  normalizeGovernanceApprovalToolEvent,
  normalizeJiuwenUsageSummary,
  normalizeJiuwenMode,
  stringifyJiuwenToolPayload,
  recordJiuwenToolAudit,
  collectRecentWorkspaceFiles,
} from "./jiuwenclaw-bridge";
import {
  appendLogAsync,
  JIUWENCLAW_HOME,
  jiuwenClawSessionsDir,
  resolveRuntimeWorkspace,
  resolveRuntimeWorkspaceByIds,
} from "./helpers";
import { privateMessageLogFields } from "./log-privacy";
import { writeJiuwenSessionArtifacts, type JiuwenSessionArtifactFile } from "./jiuwen-session-artifacts";
import { materializeRemoteJiuwenFiles } from "./jiuwen-remote-artifacts";
import { buildJiuwenFinalSnapshot, buildJiuwenTextDelta } from "./jiuwenswarm-stream-contract";
import { filterCitedKnowledgeSources, validateKnowledgeCitations } from "@shared/knowledge-citations";
import { createResponseEvidenceCollector } from "./governance/response-evidence";
import { restoreTrustedContextReceiptInToolResult } from "./governance/context-receipt-store";
import {
  buildEnterpriseChatParams,
  prepareEnterpriseManagedMcpProvisioning,
  buildEnterpriseRuntimeAttachmentRefs,
  buildEnterprisePermissionAnswerParams,
  type EnterpriseRuntimeRoute,
} from "./enterprise-runtime-adapter";
import { EnterpriseMcpProvisioningCoordinator } from "./enterprise-mcp-provisioning-coordinator";

const DEFAULT_GATEWAY_WS_URL = "ws://127.0.0.1:19000/ws";
const GATEWAY_PROGRESS_HEARTBEAT_MS = 10_000;
const enterpriseMcpProvisioningCoordinator = new EnterpriseMcpProvisioningCoordinator(
  Math.max(30_000, Number(process.env.EA_ENTERPRISE_MCP_PROVISION_CACHE_TTL_MS || 600_000) || 600_000),
);

export type JiuwenContinuationPermission = JiuwenPermissionRequest & {
  connectorName?: string;
  demo?: boolean;
  expiresAt?: string;
};

export type JiuwenPermissionAnswerResult =
  | { ok: true; text: string; permission?: JiuwenContinuationPermission }
  | { ok: false; error: string; text?: string };

export function gatewayProgressStatus(elapsedMs: number): string {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  if (elapsed < 20_000) return "正在准备本次任务...";
  if (elapsed < 60_000) return "正在核验任务所需信息...";
  if (elapsed < 120_000) return "正在汇总多项结果，复杂任务可能需要几分钟...";
  return "正在完成结果整理...";
}

export function shouldKeepGatewayRunAfterClientClose(enterprise: boolean): boolean {
  return enterprise;
}

export function resolveGatewayArtifactWorkspace(args: {
  adoptId: string;
  defaultWorkspaceDir: string;
  enterpriseRuntimeAgentId?: string;
  resolveByIds?: typeof resolveRuntimeWorkspaceByIds;
}): string {
  const enterpriseRuntimeAgentId = String(args.enterpriseRuntimeAgentId || "").trim();
  if (!enterpriseRuntimeAgentId) return args.defaultWorkspaceDir;
  return (args.resolveByIds || resolveRuntimeWorkspaceByIds)(args.adoptId, enterpriseRuntimeAgentId);
}

export function buildGovernanceContinuationPermission(
  governance: {
    approvalId: string;
    expiresAt?: string;
    reason: string;
    policyCode?: string;
    toolName?: string;
    connectorName?: string;
    demo?: boolean;
  },
  fallbackToolName: string,
): JiuwenContinuationPermission {
  return {
    requestId: governance.approvalId,
    source: "governance_approval",
    kind: "permission",
    title: "操作确认",
    question: governance.reason,
    toolName: governance.toolName || fallbackToolName,
    options: [
      { label: "本次允许", value: "本次允许", description: "仅本次允许执行" },
      { label: "拒绝", value: "拒绝", description: "拒绝本次执行" },
    ],
    riskLevel: "high",
    reasonCode: governance.policyCode || "EA_APPROVAL_REQUIRED",
    reasonText: governance.reason,
    allowAlways: false,
    ...(governance.connectorName ? { connectorName: governance.connectorName } : {}),
    ...(governance.demo !== undefined ? { demo: governance.demo } : {}),
    ...(governance.expiresAt ? { expiresAt: governance.expiresAt } : {}),
  };
}

function gatewayWsUrl(route?: EnterpriseRuntimeRoute): string {
  return route?.wsUrl || String(process.env.JIUWENCLAW_GATEWAY_WS_URL || DEFAULT_GATEWAY_WS_URL);
}

function wsOrigin(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
}

function parseJsonFrame(raw: RawData): any | null {
  try {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function enterpriseMcpProvisioningFrameResult(
  frame: any,
  requestId: string,
): { status: "success" | "error"; error?: string } | null {
  if (!frame || String(requestId || "") === "") return null;
  if (frame.type === "res" && frame.id === requestId) {
    return frame.ok === false
      ? { status: "error", error: String(frame.error || frame.payload?.error || "enterprise MCP provisioning failed") }
      : { status: "success" };
  }
  if (
    frame.type === "event"
    && frame.request_id === requestId
    && frame.event === "chat.error"
  ) {
    const payload = eventPayload(frame);
    return {
      status: "error",
      error: String(payload.error || payload.message || "enterprise MCP provisioning failed"),
    };
  }
  return null;
}

export function enterpriseMcpProvisioningAcceptanceDelayMs(value: unknown): number {
  const parsed = Number(value);
  return Math.min(30_000, Math.max(500, Number.isFinite(parsed) ? parsed : 8_000));
}

export function gatewayPermissionAnswerMethod(
  enterprise: boolean,
  source: unknown,
): "chat.send" | "chat.user_answer" {
  if (!enterprise) return "chat.send";
  return String(source || "permission_interrupt").trim() === "permission_interrupt"
    ? "chat.send"
    : "chat.user_answer";
}

export function gatewayPermissionEventMatchesRequest(
  frame: any,
  requestId: string,
  answerMethod: "chat.send" | "chat.user_answer",
  enterprise: boolean,
): boolean {
  if (!enterprise || answerMethod !== "chat.send" || frame?.type !== "event") return true;
  return String(frame.request_id || "") === requestId;
}

function initSse(res: Response): void {
  if (!res.headersSent) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
  }
  if (res.socket) res.socket.setNoDelay(true);
}

function eventPayload(frame: any): Record<string, unknown> {
  const payload = frame?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function payloadSessionId(payload: Record<string, unknown>): string {
  const direct = payload.session_id;
  return typeof direct === "string" ? direct : "";
}

function buildGatewayChatParams(args: {
  serviceId: string;
  agentId: string;
  sessionId: string;
  channelId: string;
  message: string;
  workspaceDir: string;
  model?: string;
  runtimeMode?: unknown;
  selectedSkills?: JiuwenSelectedSkillMetadata[];
}) {
  const mode = normalizeJiuwenMode(args.runtimeMode || process.env.JIUWENCLAW_DEFAULT_MODE);
  const selectedSkills = Array.isArray(args.selectedSkills) ? args.selectedSkills : [];
  const mediaItems = buildJiuwenImageMediaItems(args.message, args.workspaceDir);
  return {
    service_id: args.serviceId,
    agent_id: args.agentId,
    session_id: args.sessionId,
    query: args.message,
    content: args.message,
    project_dir: args.workspaceDir,
    interactive_ask: true,
    request_metadata: {
      effective_project_dir: args.workspaceDir,
      source_channel: args.channelId,
      ...(selectedSkills.length ? { selected_skills: selectedSkills } : {}),
    },
    mode,
    ...(mediaItems.length ? { media_items: mediaItems } : {}),
    ...(args.model ? { model_name: args.model } : {}),
  };
}

function buildGatewayPermissionAnswerParams(args: {
  serviceId: string;
  agentId: string;
  sessionId: string;
  channelId: string;
  workspaceDir: string;
  permissionRequestId: string;
  selectedOption: string;
  answers?: JiuwenInteractionAnswer[];
  source?: string;
  runtimeMode?: unknown;
}) {
  const mode = normalizeJiuwenMode(args.runtimeMode || process.env.JIUWENCLAW_DEFAULT_MODE);
  const source = String(args.source || "permission_interrupt").trim() || "permission_interrupt";
  return {
    service_id: args.serviceId,
    agent_id: args.agentId,
    session_id: args.sessionId,
    query: "",
    content: "",
    project_dir: args.workspaceDir,
    request_id: args.permissionRequestId,
    answers: args.answers?.length
      ? args.answers.map((answer) => ({
          selected_options: answer.selectedOptions,
          custom_input: answer.customInput,
        }))
      : [{ selected_options: [args.selectedOption], custom_input: "" }],
    source,
    mode,
    request_metadata: {
      effective_project_dir: args.workspaceDir,
      source_channel: args.channelId,
    },
  };
}

function sendGatewayRequest(ws: WebSocket, method: string, id: string, params: Record<string, unknown>): void {
  ws.send(JSON.stringify({
    type: "req",
    id,
    method,
    params,
  }));
}

function writeSseData(res: Response, obj: any): void {
  if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function writeSseEvent(res: Response, event: string, obj: any): void {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
}

function emitSseDone(res: Response, durationMs?: number): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify({
    __stream_end: true,
    ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, Math.round(Number(durationMs))) } : {}),
  })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function gatewayEventToText(eventType: string, payload: Record<string, unknown>): string {
  if (eventType === "chat.delta") {
    return String(payload.content || "");
  }
  return "";
}

export function shouldDeferSelectedSkillText(
  selectedSkills: JiuwenForwardOptions["selectedSkills"],
): boolean {
  return Array.isArray(selectedSkills) && selectedSkills.length > 0;
}

function shouldFinishGatewayStream(eventType: string, payload: Record<string, unknown>): boolean {
  if (eventType === "chat.final" || eventType === "chat.session_result") return true;
  if (eventType === "chat.processing_status" && payload.is_processing === false) return true;
  if (eventType === "chat.error") return true;
  return false;
}

async function handleGatewayEvent(args: {
  claw: JiuwenClawRuntimeClaw;
  req?: Request;
  res?: Response;
  eventType: string;
  payload: Record<string, unknown>;
  requestId: string;
  agentId: string;
  sessionId: string;
  channelId: string;
  workspaceDir: string;
  artifactWorkspaceDir?: string;
  collectText?: (text: string) => void;
  collectFiles?: (files: JiuwenSessionArtifactFile[]) => void;
  collectUsage?: (usage: Record<string, number>) => void;
  collectPermission?: (permission: JiuwenContinuationPermission) => void;
  knowledgeCitationIndexes?: number[];
  remoteFileWsUrl?: string;
  deferAssistantText?: boolean;
}): Promise<"permission" | "done" | "continue"> {
  const { eventType, payload } = args;
  const text = gatewayEventToText(eventType, payload);
  if (text) {
    const publicText = sanitizePublicRuntimePaths(text, args.workspaceDir);
    args.collectText?.(publicText);
    if (args.res && !args.deferAssistantText) {
      writeSseData(args.res, buildJiuwenTextDelta(publicText));
    }
  }

  if (eventType === "chat.final") {
    const finalSnapshot = buildJiuwenFinalSnapshot(
      String(payload.content || ""),
      args.workspaceDir,
      args.knowledgeCitationIndexes,
    );
    if (finalSnapshot && args.res && !args.deferAssistantText) {
      writeSseData(args.res, finalSnapshot);
    }
  }

  if (eventType === "chat.usage_summary" || eventType === "chat.usage_metadata" || eventType === "context.usage") {
    const usageSummary = normalizeJiuwenUsageSummary(payload);
    if (usageSummary) {
      args.collectUsage?.(usageSummary.usage);
      if (args.res) writeSseData(args.res, {
        __perf: {
          usage: usageSummary.usage,
          ...(usageSummary.model ? { model: usageSummary.model } : {}),
        },
      });
    }
  }

  const permissionRequest = normalizeJiuwenPermissionRequest(eventType, payload, args.requestId);
  if (permissionRequest) {
    args.collectPermission?.(permissionRequest);
    if (args.res) appendLogAsync("jiuwenclaw-exec.log", {
      ts: new Date().toISOString(),
      event: "gateway_human_approval_required",
      adoptId: args.claw.adoptId,
      agentId: args.agentId,
      sessionId: args.sessionId,
      channelId: args.channelId,
      requestId: args.requestId,
      permissionRequestId: permissionRequest.requestId,
      source: permissionRequest.source,
      toolName: permissionRequest.toolName || "",
    });
    if (args.res) {
      writeSseEvent(args.res, "jiuwen_permission_request", {
        ...permissionRequest,
        adoptId: args.claw.adoptId,
        agentId: args.agentId,
        sessionId: args.sessionId,
        channelId: args.channelId,
      });
      writeSseData(args.res, { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
    }
    return "permission";
  }

  const artifactWorkspaceDir = args.artifactWorkspaceDir || args.workspaceDir;
  let files = normalizeJiuwenFileEvent(payload, artifactWorkspaceDir);
  if (
    args.remoteFileWsUrl
    && (eventType === "chat.file" || eventType === "chat.media")
  ) {
    const remoteFiles = await materializeRemoteJiuwenFiles({
      delta: payload,
      wsUrl: args.remoteFileWsUrl,
      workspaceDir: artifactWorkspaceDir,
      requestId: args.requestId,
    });
    if (remoteFiles.length > 0) files = remoteFiles;
  }
  if (files.length > 0) args.collectFiles?.(files);
  for (const file of files) {
    if (args.res) writeSseEvent(args.res, "workspace_files", { adoptId: args.claw.adoptId, files: [file] });
  }

  const tool = normalizeJiuwenToolPayload(eventType, payload);
  if (tool) {
    await recordJiuwenToolAudit({
      claw: args.claw,
      req: args.req,
      agentId: args.agentId,
      sessionId: args.sessionId,
      requestId: args.requestId,
      channelId: args.channelId,
      eventType,
      delta: payload,
    });
    const resultText = stringifyJiuwenToolPayload(tool.resultPayload);
    const publicResultText = sanitizePublicRuntimePaths(resultText, args.workspaceDir);
    const governanceApproval = tool.isResult
      ? normalizeGovernanceApprovalToolEvent(payload, tool.resultPayload)
      : null;
    const governancePermission: JiuwenContinuationPermission | null = governanceApproval
      ? buildGovernanceContinuationPermission(governanceApproval, tool.toolName)
      : null;
    if (governancePermission) {
      args.collectPermission?.(governancePermission);
    }
    if (governancePermission && args.res) {
      writeSseEvent(args.res, "governance_approval_required", {
        ...governancePermission,
        adoptId: args.claw.adoptId,
      });
    }
    const shouldEmitToolResult = !tool.isResult || tool.isError || resultText.trim().length > 0;
    if (args.res) {
      if (tool.isResult) {
        if (shouldEmitToolResult) {
          writeSseEvent(args.res, "tool_result", {
            tool_call_id: tool.callId,
            name: tool.toolName,
            result: publicResultText,
            is_error: tool.isError,
            executor: "jiuwenswarm",
            adoptId: args.claw.adoptId,
          });
        }
      } else {
        writeSseEvent(args.res, "tool_call", {
          id: tool.callId,
          name: tool.toolName,
          arguments: sanitizePublicRuntimePaths(stringifyJiuwenToolPayload(tool.argumentsPayload) || "{}", args.workspaceDir),
          executor: "jiuwenswarm",
          adoptId: args.claw.adoptId,
        });
      }
    }
    if (governancePermission) return "permission";
  }

  return shouldFinishGatewayStream(eventType, payload) ? "done" : "continue";
}

export async function forwardToJiuwenGateway(
  claw: JiuwenClawRuntimeClaw,
  message: string,
  res: Response,
  opts: JiuwenForwardOptions = {},
  enterpriseRoute?: EnterpriseRuntimeRoute,
): Promise<void> {
  initSse(res);

  const msgTrim = String(message || "").trim();
  const deferSelectedSkillText = shouldDeferSelectedSkillText(opts.selectedSkills);
  if (msgTrim === "/new" || msgTrim === "/reset") {
    bumpSessionEpoch(claw.adoptId);
    writeSseData(res, { choices: [{ delta: { content: "已开始新对话。" }, index: 0 }] });
    writeSseData(res, { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
    emitSseDone(res);
    return;
  }


  if (enterpriseRoute) {
    writeSseData(res, { __model_selected: String(process.env.EA_ENTERPRISE_RUNTIME_MODEL_ALIAS || "ea-auto") });
  } else if (opts.model) {
    writeSseData(res, { __model_selected: opts.model });
  }
  if (opts.knowledgeSources?.length) writeSseData(res, { __knowledge_sources: opts.knowledgeSources });

  const wsUrl = gatewayWsUrl(enterpriseRoute);
  const serviceId = enterpriseRoute?.binding.serviceId || buildJiuwenServiceId();
  if (opts.collaboration && enterpriseRoute) throw new Error("Enterprise collaboration isolation is unavailable");
  const agentId = opts.collaboration?.runtimeAgentId || enterpriseRoute?.binding.runtimeAgentId || buildJiuwenAgentId(claw);
  const sessionId = buildJiuwenSessionId(claw, agentId, opts);
  const channelId = claw.adoptId;
  const workspaceDir = opts.collaboration?.workspaceDir || resolveRuntimeWorkspace(claw, claw.adoptId);
  const artifactWorkspaceDir = resolveGatewayArtifactWorkspace({
    adoptId: claw.adoptId,
    defaultWorkspaceDir: workspaceDir,
    enterpriseRuntimeAgentId: enterpriseRoute?.binding.runtimeAgentId,
  });
  const runtimeAttachments = enterpriseRoute
    ? buildEnterpriseRuntimeAttachmentRefs(opts.uploadedAttachments || [], workspaceDir)
    : [];
  const requestId = `linggan-gateway-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const params = enterpriseRoute
    ? buildEnterpriseChatParams({
        route: enterpriseRoute,
        sessionId,
        message,
        adoptId: claw.adoptId,
        agentId: claw.agentId,
        runtimeMode: opts.runtimeMode,
        modelName: opts.modelName,
        selectedSkills: opts.selectedSkills,
        runtimeAttachments,
        resumeGovernanceApprovalId: opts.resumeGovernanceApprovalId,
      })
    : buildGatewayChatParams({
        serviceId,
        agentId,
        sessionId,
        channelId,
        message,
        workspaceDir,
        model: opts.model,
        runtimeMode: opts.runtimeMode,
        selectedSkills: opts.selectedSkills,
      });
  const managedMcpProvisioning = enterpriseRoute
    ? await prepareEnterpriseManagedMcpProvisioning({
        route: enterpriseRoute,
        adoptId: claw.adoptId,
        agentId: claw.agentId,
      })
    : null;
  const managedMcpRequestId = `${requestId}:managed-mcp`;
  const knowledgeCitationIndexes = (opts.knowledgeSources || [])
    .map((source) => Number(source?.index || 0))
    .filter((index) => Number.isInteger(index) && index > 0);

  writeSseData(res, {
    __run: buildJiuwenRunDescriptor({
      clientRunId: opts.clientRunId,
      requestId,
      sessionId,
    }),
  });

  appendLogAsync("jiuwenclaw-exec.log", {
    ts: new Date().toISOString(),
    event: "gateway_chat_request",
    adoptId: claw.adoptId,
    selectedSkillIds: (opts.selectedSkills || []).map((skill) => skill.id).filter(Boolean),
    agentId,
    serviceId,
    sessionId,
    channelId,
    requestId,
    userId: claw.userId,
    clientRunId: opts.clientRunId || "",
    model: opts.model || "",
    runtimeProfile: enterpriseRoute?.profile || "standalone",
    gatewayTarget: enterpriseRoute?.gatewayTarget || "",
    wsUrl,
    ...privateMessageLogFields(message),
  });

  let enterpriseBootstrapFallback = false;
  await new Promise<void>((resolve) => {
    const startedAt = Date.now();
    const generatedFiles = new Map<string, JiuwenSessionArtifactFile>();
    const emittedFilePaths = new Set<string>();
    const memoryToolNames = new Set<string>();
    const responseEvidence = createResponseEvidenceCollector(claw, agentId, sessionId, requestId);
    let memoryAssistantText = "";
    let finalAssistantText = "";
    let settled = false;
    let clientClosed = false;
    let requestSent = false;
    let managedMcpRequestSent = false;
    let managedMcpProvisionResolve: (() => void) | null = null;
    let managedMcpProvisionReject: ((error: Error) => void) | null = null;
    let managedMcpProvisionTimer: NodeJS.Timeout | null = null;
    let connectionAckTimer: NodeJS.Timeout | null = null;
    let progressHeartbeat: NodeJS.Timeout | null = null;
    const timeoutMs = Math.max(30_000, Number(process.env.JIUWENCLAW_GATEWAY_CHAT_TIMEOUT_MS || process.env.JIUWENCLAW_CHAT_TIMEOUT_MS || 180_000) || 180_000);
    const ws = new WebSocket(wsUrl, enterpriseRoute ? { headers: { Origin: wsOrigin(wsUrl) } } : undefined);
    const sendChatRequest = () => {
      if (requestSent || ws.readyState !== WebSocket.OPEN) return;
      requestSent = true;
      sendGatewayRequest(ws, "chat.send", requestId, params);
    };
    const provisionManagedMcpOrSendChat = () => {
      if (!managedMcpProvisioning) {
        sendChatRequest();
        return;
      }
      void enterpriseMcpProvisioningCoordinator.ensure(
        managedMcpProvisioning.fingerprint,
        () => new Promise<void>((resolveProvision, rejectProvision) => {
          if (managedMcpRequestSent || ws.readyState !== WebSocket.OPEN) {
            rejectProvision(new Error("enterprise MCP provisioning socket unavailable"));
            return;
          }
          managedMcpRequestSent = true;
          managedMcpProvisionResolve = resolveProvision;
          managedMcpProvisionReject = rejectProvision;
          const acceptanceDelayMs = enterpriseMcpProvisioningAcceptanceDelayMs(
            process.env.EA_ENTERPRISE_MCP_PROVISION_ACCEPTANCE_DELAY_MS,
          );
          managedMcpProvisionTimer = setTimeout(() => {
            managedMcpProvisionTimer = null;
            const acceptProvision = managedMcpProvisionResolve;
            managedMcpProvisionReject = null;
            managedMcpProvisionResolve = null;
            appendLogAsync("jiuwenclaw-exec.log", {
              ts: new Date().toISOString(),
              event: "enterprise_mcp_provision_accepted",
              adoptId: claw.adoptId,
              bindingId: enterpriseRoute?.binding.bindingId || "",
              acceptanceDelayMs,
              protocolMode: "background_rpc_without_ack",
            });
            acceptProvision?.();
          }, acceptanceDelayMs);
          sendGatewayRequest(ws, "tools.add", managedMcpRequestId, managedMcpProvisioning.params);
        }),
      ).then(() => {
        sendChatRequest();
      }).catch((error) => {
        if (settled) return;
        const errorMessage = String(error instanceof Error ? error.message : error);
        appendLogAsync("jiuwenclaw-exec.log", {
          ts: new Date().toISOString(),
          event: "enterprise_mcp_provision_failed",
          adoptId: claw.adoptId,
          bindingId: enterpriseRoute?.binding.bindingId || "",
          error: errorMessage,
        });
        writeSseData(res, {
          __stream_error: true,
          error: "企业能力初始化失败，请稍后重试。",
          reasonCode: "enterprise_mcp_provision_failed",
        });
        settle("managed-mcp-error");
      });
    };
    const settle = (reason: string) => {
      if (settled) return;
      settled = true;
      const rejectPendingProvision = managedMcpProvisionReject;
      managedMcpProvisionResolve = null;
      managedMcpProvisionReject = null;
      if (rejectPendingProvision) {
        rejectPendingProvision(new Error(`enterprise MCP provisioning interrupted: ${reason}`));
      }
      if (reason !== "enterprise-bootstrap-fallback") {
        opts.onRuntimeOutcome?.(
          reason === "done" || reason === "permission-required"
            ? "success"
            : reason === "timeout"
              ? "timeout"
            : reason === "client-closed"
              ? "cancelled"
              : "error",
        );
      }
      clearTimeout(timeout);
      if (connectionAckTimer) clearTimeout(connectionAckTimer);
      if (managedMcpProvisionTimer) clearTimeout(managedMcpProvisionTimer);
      if (progressHeartbeat) clearInterval(progressHeartbeat);
      for (const file of collectRecentWorkspaceFiles(workspaceDir, startedAt).slice(0, 20)) {
        generatedFiles.set(file.path, file);
        if (!emittedFilePaths.has(file.path) && !clientClosed) {
          writeSseEvent(res, "workspace_files", { adoptId: claw.adoptId, files: [file] });
          emittedFilePaths.add(file.path);
        }
      }
      if (generatedFiles.size > 0) {
        try {
          const globalSessionDir = path.join(JIUWENCLAW_HOME, "agent", "sessions", sessionId);
          const scopedSessionDir = path.join(jiuwenClawSessionsDir(claw.adoptId, agentId), sessionId);
          const sessionDirs = existsSync(globalSessionDir) ? [globalSessionDir] : [scopedSessionDir];
          for (const sessionDir of sessionDirs) {
            writeJiuwenSessionArtifacts({
              sessionDir,
              adoptId: claw.adoptId,
              requestId,
              files: Array.from(generatedFiles.values()),
            });
          }
        } catch {}
      }
      appendLogAsync("jiuwenclaw-exec.log", {
        ts: new Date().toISOString(),
        event: "gateway_chat_complete",
        adoptId: claw.adoptId,
        agentId,
        sessionId,
        channelId,
        requestId,
        userId: claw.userId,
        clientRunId: opts.clientRunId || "",
        reason,
      });
      if (reason === "enterprise-bootstrap-fallback") {
        try { ws.close(1012, reason); } catch {}
        resolve();
        return;
      }
      const rawAssistantMessage = deferSelectedSkillText
        ? memoryAssistantText.trim()
        : finalAssistantText.trim() || memoryAssistantText.trim();
      const citationValidation = validateKnowledgeCitations(rawAssistantMessage, knowledgeCitationIndexes);
      const validatedAssistantMessage = citationValidation.text;
      if (
        reason === "done"
        && validatedAssistantMessage
        && !clientClosed
        && (deferSelectedSkillText || validatedAssistantMessage !== rawAssistantMessage)
      ) {
        writeSseData(res, { __final_text: validatedAssistantMessage });
      }
      const citedKnowledgeSources = reason === "done" && opts.knowledgeSources?.length
        ? filterCitedKnowledgeSources(opts.knowledgeSources, citationValidation.citedIndexes)
        : [];
      if (citedKnowledgeSources.length && !clientClosed) {
        writeSseData(res, {
          __knowledge_sources: citedKnowledgeSources,
        });
      }
      const assistantMessage = validatedAssistantMessage;
      if (reason === "done" && assistantMessage) {
        const finalizedEvidence = responseEvidence.finalize(assistantMessage, citedKnowledgeSources);
        if (finalizedEvidence && !clientClosed) writeSseData(res, { __context_response_evidence: finalizedEvidence });
      }
      if (!opts.collaboration && reason === "done" && assistantMessage) {
        void import("./agent-memory").then(({ enqueueAgentMemoryTurn }) => enqueueAgentMemoryTurn({
          userId: claw.userId,
          adoptId: claw.adoptId,
          roleTemplate: claw.roleTemplate || "general-assistant",
          channel: String(opts.channel || "web"),
          sessionId,
          requestId,
          conversationId: String(opts.conversationId || ""),
          messageId: requestId,
          userMessage: opts.memoryUserMessage || message,
          assistantMessage,
          selectedSkillIds: (opts.selectedSkills || []).map((skill) => skill.id).filter(Boolean),
          toolNames: Array.from(memoryToolNames),
        })).catch(() => {});
      }
      try { ws.close(1000, reason); } catch {}
      if (!clientClosed) emitSseDone(res, Date.now() - startedAt);
      resolve();
    };
    const timeout = setTimeout(() => {
      writeSseData(res, {
        __stream_error: true,
        error: "模型或网页服务响应较慢，可重试或切换其他模型。",
        reasonCode: "runtime_timeout",
        durationMs: Date.now() - startedAt,
      });
      settle("timeout");
    }, timeoutMs);
    const writeProgressHeartbeat = () => {
      if (settled || clientClosed) return;
      writeSseData(res, {
        __status: gatewayProgressStatus(Date.now() - startedAt),
        kind: "heartbeat",
        elapsedMs: Date.now() - startedAt,
      });
      res.flush?.();
    };
    writeProgressHeartbeat();
    progressHeartbeat = setInterval(writeProgressHeartbeat, GATEWAY_PROGRESS_HEARTBEAT_MS);
    res.on("close", () => {
      if (!settled) {
        clientClosed = true;
        if (shouldKeepGatewayRunAfterClientClose(Boolean(enterpriseRoute))) {
          if (progressHeartbeat) clearInterval(progressHeartbeat);
          appendLogAsync("jiuwenclaw-exec.log", {
            ts: new Date().toISOString(),
            event: "gateway_chat_client_detached",
            adoptId: claw.adoptId,
            agentId,
            sessionId,
            requestId,
            clientRunId: opts.clientRunId || "",
          });
        } else {
          try { ws.close(1000, "client closed"); } catch {}
        }
      }
    });
    ws.on("open", () => {
      if (requestSent) return;
      if (enterpriseRoute) {
        connectionAckTimer = setTimeout(() => {
          if (requestSent || ws.readyState !== WebSocket.OPEN) return;
          provisionManagedMcpOrSendChat();
        }, 2_000);
        return;
      }
      sendChatRequest();
    });
    ws.on("message", async (raw) => {
      const frame = parseJsonFrame(raw);
      if (!frame || settled) return;
      if (enterpriseRoute && frame.type === "event" && frame.event === "connection.ack") {
        if (connectionAckTimer) clearTimeout(connectionAckTimer);
        provisionManagedMcpOrSendChat();
        return;
      }
      const managedMcpResult = enterpriseMcpProvisioningFrameResult(frame, managedMcpRequestId);
      if (managedMcpResult) {
        if (managedMcpProvisionTimer) clearTimeout(managedMcpProvisionTimer);
        managedMcpProvisionTimer = null;
        if (managedMcpResult.status === "error") {
          const rejectProvision = managedMcpProvisionReject;
          managedMcpProvisionResolve = null;
          managedMcpProvisionReject = null;
          rejectProvision?.(new Error(managedMcpResult.error || "enterprise MCP provisioning failed"));
          return;
        }
        const resolveProvision = managedMcpProvisionResolve;
        managedMcpProvisionResolve = null;
        managedMcpProvisionReject = null;
        resolveProvision?.();
        return;
      }
      if (frame.type === "res" && frame.id === requestId && frame.ok === false) {
        const message = String(frame.error || "JiuwenSwarm gateway 请求失败");
        if (enterpriseRoute && message.includes("EA_RUNTIME_ASSET_BOOTSTRAP_FAILED")) {
          enterpriseBootstrapFallback = true;
          settle("enterprise-bootstrap-fallback");
          return;
        }
        writeSseData(res, { __stream_error: true, error: message });
        settle("request-error");
        return;
      }
      if (frame.type !== "event") return;
      const eventType = String(frame.event || "");
      let payload = eventPayload(frame);
      const sid = payloadSessionId(payload);
      if (sid && sid !== sessionId) return;
      if (eventType === "chat.tool_result") {
        payload = await restoreTrustedContextReceiptInToolResult({
          payload,
          sessionId,
          adoptionId: claw.adoptId,
          eventTime: Date.now(),
        }).catch(() => payload);
      }
      const memoryTool = normalizeJiuwenToolPayload(eventType, payload);
      if (deferSelectedSkillText && memoryTool && !memoryTool.isResult) {
        memoryAssistantText = "";
        finalAssistantText = "";
      }
      if (eventType === "chat.error") {
        const message = String(payload.error || payload.message || "JiuwenSwarm gateway 返回错误");
        if (enterpriseRoute && message.includes("EA_RUNTIME_ASSET_BOOTSTRAP_FAILED")) {
          enterpriseBootstrapFallback = true;
          settle("enterprise-bootstrap-fallback");
          return;
        }
        writeSseData(res, { __stream_error: true, error: message });
      }
      if (eventType === "chat.final" && String(payload.content || "").trim()) {
        finalAssistantText = validateKnowledgeCitations(
          sanitizePublicRuntimePaths(String(payload.content || ""), workspaceDir),
          knowledgeCitationIndexes,
        ).text;
      }
      if (memoryTool?.toolName) memoryToolNames.add(memoryTool.toolName);
      if (memoryTool?.isResult) {
        responseEvidence.capture(memoryTool.toolName, memoryTool.resultPayload);
      }
      const action = await handleGatewayEvent({
        claw,
        req: opts.req,
        res,
        eventType,
        payload,
        requestId,
        agentId,
        sessionId,
        channelId,
        workspaceDir,
        artifactWorkspaceDir,
        collectText: (text) => {
          if (text) opts.onFirstToken?.();
          memoryAssistantText += text;
        },
        collectFiles: (files) => {
          for (const file of files.slice(0, 20)) {
            generatedFiles.set(file.path, file);
            emittedFilePaths.add(file.path);
          }
        },
        collectUsage: opts.onUsage,
        knowledgeCitationIndexes,
        deferAssistantText: deferSelectedSkillText,
        ...(enterpriseRoute ? { remoteFileWsUrl: wsUrl } : {}),
      });
      if (action === "permission") {
        settle("permission-required");
      } else if (action === "done") {
        writeSseData(res, { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
        settle("done");
      }
    });
    ws.on("error", (err) => {
      if (settled) return;
      writeSseData(res, { __stream_error: true, error: String((err as any)?.message || err || "JiuwenSwarm gateway 连接失败") });
      settle("ws-error");
    });
    ws.on("close", () => {
      if (!settled) settle(clientClosed ? "client-closed" : "ws-close");
    });
  });
  if (enterpriseBootstrapFallback && enterpriseRoute) {
    appendLogAsync("jiuwenclaw-exec.log", {
      ts: new Date().toISOString(),
      event: "enterprise_runtime_asset_bootstrap_fallback",
      adoptId: claw.adoptId,
      bindingId: enterpriseRoute.binding.bindingId,
      assetSetFingerprint: enterpriseRoute.binding.assetSetFingerprint,
    });
    return forwardToJiuwenGateway(claw, message, res, opts);
  }
}

export async function answerJiuwenGatewayPermission(
  claw: JiuwenClawRuntimeClaw,
  args: {
    permissionRequestId: string;
    selectedOption: string;
    answers?: JiuwenInteractionAnswer[];
    source?: string;
    model?: string;
    channel?: unknown;
    conversationId?: unknown;
    epochLabel?: unknown;
    runtimeMode?: unknown;
  },
  enterpriseRoute?: EnterpriseRuntimeRoute,
): Promise<JiuwenPermissionAnswerResult> {
  const permissionRequestId = String(args.permissionRequestId || "").trim();
  if (!permissionRequestId) return { ok: false, error: "permissionRequestId required" };

  const wsUrl = gatewayWsUrl(enterpriseRoute);
  const serviceId = enterpriseRoute?.binding.serviceId || buildJiuwenServiceId();
  const agentId = enterpriseRoute?.binding.runtimeAgentId || buildJiuwenAgentId(claw);
  const sessionId = buildJiuwenSessionId(claw, agentId, args);
  const channelId = claw.adoptId;
  const workspaceDir = resolveRuntimeWorkspace(claw, claw.adoptId);
  const artifactWorkspaceDir = resolveGatewayArtifactWorkspace({
    adoptId: claw.adoptId,
    defaultWorkspaceDir: workspaceDir,
    enterpriseRuntimeAgentId: enterpriseRoute?.binding.runtimeAgentId,
  });
  const requestId = `linggan-gateway-answer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const params = enterpriseRoute
    ? buildEnterprisePermissionAnswerParams({
        route: enterpriseRoute,
        sessionId,
        permissionRequestId,
        selectedOption: args.selectedOption,
        answers: args.answers,
        source: args.source,
        runtimeMode: args.runtimeMode,
      })
    : buildGatewayPermissionAnswerParams({
        serviceId,
        agentId,
        sessionId,
        channelId,
        workspaceDir,
        permissionRequestId,
        selectedOption: args.selectedOption,
        answers: args.answers,
        source: args.source,
        runtimeMode: args.runtimeMode,
      });

  appendLogAsync("jiuwenclaw-exec.log", {
    ts: new Date().toISOString(),
    event: "gateway_permission_answer_request",
    adoptId: claw.adoptId,
    agentId,
    serviceId,
    sessionId,
    channelId,
    userId: claw.userId,
    requestId,
    permissionRequestId,
    selectedOption: args.selectedOption,
    answerCount: args.answers?.length || 1,
    source: args.source || "permission_interrupt",
    wsUrl,
    runtimeProfile: enterpriseRoute?.profile || "standalone",
    gatewayTarget: enterpriseRoute?.gatewayTarget || "",
  });

  return await new Promise((resolve) => {
    let settled = false;
    let requestSent = false;
    let connectionAckTimer: NodeJS.Timeout | null = null;
    let text = "";
    let sawDone = false;
    let continuationPermission: JiuwenContinuationPermission | undefined;
    const defaultTimeoutMs = enterpriseRoute ? 300_000 : 180_000;
    const timeoutMs = Math.max(
      15_000,
      Number(
        process.env.JIUWENCLAW_GATEWAY_PERMISSION_TIMEOUT_MS
        || process.env.JIUWENCLAW_PERMISSION_TIMEOUT_MS
        || defaultTimeoutMs,
      ) || defaultTimeoutMs,
    );
    const answerMethod = gatewayPermissionAnswerMethod(Boolean(enterpriseRoute), args.source);
    const ws = new WebSocket(wsUrl, enterpriseRoute ? { headers: { Origin: wsOrigin(wsUrl) } } : undefined);
    const settle = (result: { ok: true; text: string } | { ok: false; error: string; text?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (connectionAckTimer) clearTimeout(connectionAckTimer);
      appendLogAsync("jiuwenclaw-exec.log", {
        ts: new Date().toISOString(),
        event: result.ok ? "gateway_permission_answer_complete" : "gateway_permission_answer_failed",
        adoptId: claw.adoptId,
        agentId,
        sessionId,
        channelId,
        requestId,
        permissionRequestId,
        textBytes: Buffer.byteLength(text, "utf8"),
        ...(!result.ok ? { error: result.error } : {}),
      });
      try { ws.close(1000, result.ok ? "permission answer complete" : "permission answer failed"); } catch {}
      resolve(result);
    };
    const timeout = setTimeout(() => {
      settle({ ok: false, error: "JiuwenSwarm gateway 权限确认后等待结果超时。", text });
    }, timeoutMs);
    ws.on("open", () => {
      if (requestSent) return;
      if (enterpriseRoute) {
        connectionAckTimer = setTimeout(() => {
          if (requestSent || ws.readyState !== WebSocket.OPEN) return;
          requestSent = true;
          sendGatewayRequest(ws, answerMethod, requestId, params);
        }, 2_000);
        return;
      }
      requestSent = true;
      sendGatewayRequest(ws, answerMethod, requestId, params);
    });
    ws.on("message", async (raw) => {
      const frame = parseJsonFrame(raw);
      if (!frame || settled) return;
      if (enterpriseRoute && frame.type === "event" && frame.event === "connection.ack") {
        if (connectionAckTimer) clearTimeout(connectionAckTimer);
        if (!requestSent && ws.readyState === WebSocket.OPEN) {
          requestSent = true;
          sendGatewayRequest(ws, answerMethod, requestId, params);
        }
        return;
      }
      if (frame.type === "res" && frame.id === requestId && frame.ok === false) {
        settle({ ok: false, error: String(frame.error || "JiuwenSwarm gateway 权限确认失败"), text });
        return;
      }
      if (frame.type !== "event") return;
      if (!gatewayPermissionEventMatchesRequest(
        frame,
        requestId,
        answerMethod,
        Boolean(enterpriseRoute),
      )) return;
      const eventType = String(frame.event || "");
      const payload = eventPayload(frame);
      const sid = payloadSessionId(payload);
      if (sid && sid !== sessionId) return;
      const action = await handleGatewayEvent({
        claw,
        eventType,
        payload,
        requestId,
        agentId,
        sessionId,
        channelId,
        workspaceDir,
        artifactWorkspaceDir,
        ...(enterpriseRoute ? { remoteFileWsUrl: wsUrl } : {}),
        collectText: (chunk) => {
          text += chunk;
        },
        collectPermission: (permission) => {
          continuationPermission = permission;
        },
      });
      if (action === "permission") {
        settle({ ok: true, text, ...(continuationPermission ? { permission: continuationPermission } : {}) });
        return;
      }
      if (action === "done") {
        sawDone = true;
        settle({ ok: true, text });
      }
    });
    ws.on("error", (err) => {
      settle({ ok: false, error: String((err as any)?.message || err || "JiuwenSwarm gateway 连接失败"), text });
    });
    ws.on("close", () => {
      if (!settled) {
        settle(sawDone || text
          ? { ok: true, text }
          : { ok: false, error: "JiuwenSwarm gateway 权限确认连接已关闭但未返回结果。", text });
      }
    });
  });
}
