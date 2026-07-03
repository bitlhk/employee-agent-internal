import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import {
  buildRuntimeSessionKey,
  requireClawOwner,
  resolveRuntimeAgentId,
  resolveRuntimeWorkspace,
  sanitizeRelPath,
} from "./helpers";
import { buildChatRequestBody, type PermissionProfile } from "./tool_schema";

type ExcelFillRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "planned" | "completed" | "error";
  workbookPath: string;
  contextPaths: string[];
  instruction: string;
  requestPath?: string;
  planPath?: string;
  resultPath?: string;
  resultNotePath?: string;
  plan?: string;
  resultSummary?: string;
  error?: string;
};

const MAX_RECORDS = 100;
const EXCEL_EXT_RE = /\.(xlsx|xls)$/i;

function safeTaskId(input: string) {
  return String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 80) || crypto.randomUUID();
}

function safeFileStem(input: string) {
  return String(input || "excel-fill")
    .replace(/\.[^.]+$/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40) || "excel-fill";
}

function safeRel(input: unknown) {
  const rel = sanitizeRelPath(String(input || ""));
  if (!rel || rel.includes("..")) return null;
  return rel;
}

function safeJoin(workspace: string, relPath: string) {
  const rel = safeRel(relPath);
  if (!rel) return null;
  const abs = path.normalize(path.join(workspace, rel));
  if (!abs.startsWith(workspace + path.sep) && abs !== workspace) return null;
  return abs;
}

function ensureExcelRoot(workspace: string) {
  const rootRel = "office/excel-fill";
  const root = path.join(workspace, rootRel);
  mkdirSync(root, { recursive: true });
  return { root, rootRel };
}

function ensureTaskDirs(workspace: string, taskId: string) {
  const safeId = safeTaskId(taskId);
  const relRoot = `office/excel-fill/${safeId}`;
  const absRoot = path.join(workspace, relRoot);
  const inputs = path.join(absRoot, "inputs");
  const outputs = path.join(absRoot, "outputs");
  mkdirSync(inputs, { recursive: true });
  mkdirSync(outputs, { recursive: true });
  return {
    id: safeId,
    relRoot,
    absRoot,
    inputs,
    outputs,
    rel: (name: string) => `${relRoot}/${name}`,
    outputRel: (name: string) => `${relRoot}/outputs/${name}`,
  };
}

function readExcelIndex(root: string): ExcelFillRecord[] {
  const p = path.join(root, "index.json");
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeExcelIndex(root: string, records: ExcelFillRecord[]) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "index.json"), JSON.stringify(records.slice(0, MAX_RECORDS), null, 2), "utf8");
}

function upsertRecord(workspace: string, record: ExcelFillRecord) {
  const { root } = ensureExcelRoot(workspace);
  const records = readExcelIndex(root);
  const next = [record, ...records.filter((item) => item?.id !== record.id)].slice(0, MAX_RECORDS);
  writeExcelIndex(root, next);
  const taskDirs = ensureTaskDirs(workspace, record.id);
  writeFileSync(path.join(taskDirs.absRoot, "meta.json"), JSON.stringify(record, null, 2), "utf8");
}

function recordForResponse(record: ExcelFillRecord, adoptId: string): ExcelFillRecord & {
  planUrl?: string;
  resultUrl?: string;
  resultNoteUrl?: string;
} {
  const download = (rel?: string) => rel
    ? `/api/claw/workspace/files/download?adoptId=${encodeURIComponent(adoptId)}&path=${encodeURIComponent(rel)}`
    : undefined;
  return {
    ...record,
    planUrl: download(record.planPath),
    resultUrl: download(record.resultPath),
    resultNoteUrl: download(record.resultNotePath),
  };
}

function listTaskOutputFiles(workspace: string, taskId: string) {
  const taskDirs = ensureTaskDirs(workspace, taskId);
  const out: string[] = [];
  try {
    for (const name of readdirSync(taskDirs.outputs)) {
      const abs = path.join(taskDirs.outputs, name);
      if (statSync(abs).isFile()) out.push(taskDirs.outputRel(name));
    }
  } catch {}
  return out;
}

async function callAgentRuntimeOffice(args: {
  claw: any;
  runtimeAgentId: string;
  sessionChannel: string;
  sessionConversationId: string;
  prompt: string;
  brandSystemPrompt: string;
  timeoutMs?: number;
}) {
  const remoteHost = process.env.CLAW_REMOTE_HOST || "127.0.0.1";
  const gatewayPort = parseInt(process.env.CLAW_GATEWAY_PORT || "18789", 10);
  const gatewayToken = process.env.CLAW_GATEWAY_TOKEN || "";
  const sessionKey = buildRuntimeSessionKey({
    runtimeAgentId: args.runtimeAgentId,
    channel: args.sessionChannel,
    conversationId: args.sessionConversationId,
  });
  const rawProfile = String(args.claw?.permissionProfile || "starter");
  const permissionProfile: PermissionProfile =
    rawProfile === "plus" || rawProfile === "internal" ? rawProfile : "starter";
  const body = Buffer.from(JSON.stringify(buildChatRequestBody({
    message: args.prompt,
    permissionProfile,
    brandSystemPrompt: args.brandSystemPrompt,
  })), "utf8");

  return await new Promise<string>((resolve, reject) => {
    const req = http.request({
      hostname: remoteHost,
      port: gatewayPort,
      path: "/v1/chat/completions",
      method: "POST",
      timeout: 0,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "Authorization": `Bearer ${gatewayToken}`,
        "x-openclaw-agent-id": args.runtimeAgentId,
        "x-openclaw-session-key": sessionKey,
      },
    }, (res) => {
      let buffer = "";
      let out = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta?.content || "";
            if (delta) out += delta;
          } catch {}
        }
      });
      res.on("end", () => {
        const text = out.trim();
        if (!text) reject(new Error("Agent Runtime 返回结果为空"));
        else resolve(text);
      });
    });
    req.on("error", reject);
    req.setTimeout(args.timeoutMs || 240_000, () => req.destroy(new Error("Agent Runtime Excel 处理超时")));
    req.write(body);
    req.end();
  });
}

function buildPlanPrompt(args: {
  taskId: string;
  workbookPath: string;
  contextPaths: string[];
  instruction: string;
  planPath: string;
}) {
  return [
    "你是企业办公 Excel 填表助手。请先做“填表方案预览”，不要修改原始 Excel 文件。",
    "",
    "工作方式：",
    "1. 读取工作空间里的 Excel 和背景资料，必要时可使用 Python、系统命令或可用工具查看文件内容。",
    "2. 不要联网安装依赖；如果当前环境无法解析某类文件，请在预览里说明限制。",
    "3. 只基于用户提供的资料推断填写内容，不要编造事实。",
    "4. 已有内容默认不覆盖；除非用户明确要求覆盖。",
    "5. 低置信度、资料不足、字段歧义的地方必须标记为“需人工确认”。",
    "",
    "输入文件：",
    `- Excel：${args.workbookPath}`,
    ...args.contextPaths.map((item) => `- 背景资料：${item}`),
    "",
    "用户填写要求：",
    args.instruction || "根据背景资料补全 Excel 空白字段，不覆盖已有内容。",
    "",
    "请输出 Markdown，固定包含以下章节：",
    "# Excel 填表方案",
    "## 任务理解",
    "## 表格结构识别",
    "## 建议填写清单",
    "用表格列出：Sheet、单元格/字段、当前值、建议填写、依据来源、置信度、是否需人工确认。",
    "## 无法判断或需确认",
    "## 写回规则",
    "",
    `同时请把同样内容写入工作空间文件：${args.planPath}`,
  ].join("\n");
}

function buildApplyPrompt(args: {
  taskId: string;
  workbookPath: string;
  contextPaths: string[];
  instruction: string;
  plan: string;
  resultPath: string;
  resultNotePath: string;
}) {
  return [
    "你是企业办公 Excel 填表执行助手。请根据已确认的填表方案，生成一个新的 Excel 副本。",
    "",
    "安全规则：",
    "1. 绝对不要覆盖原始 Excel 文件。",
    `2. 只允许把结果写入：${args.resultPath}`,
    `3. 处理说明写入：${args.resultNotePath}`,
    "4. 默认只填写空白单元格，不覆盖已有内容；用户要求覆盖时才覆盖。",
    "5. 对“需人工确认”或置信度低的内容，不要强行写入，可保留为空并写入处理说明。",
    "6. 尽量保留原工作簿格式、sheet、公式和样式。",
    "",
    "输入文件：",
    `- Excel：${args.workbookPath}`,
    ...args.contextPaths.map((item) => `- 背景资料：${item}`),
    "",
    "用户填写要求：",
    args.instruction || "根据背景资料补全 Excel 空白字段，不覆盖已有内容。",
    "",
    "已确认的填表方案：",
    args.plan.slice(0, 50000),
    "",
    "输出要求：",
    "1. 如果成功生成 Excel，请简要说明填写了哪些字段、跳过了哪些字段。",
    "2. 如果无法生成 Excel，请说明具体缺少什么能力，并把可复制的填写清单写入处理说明文件。",
  ].join("\n");
}

export function registerOfficeExcelRoutes(app: express.Express) {
  app.get("/api/claw/office/excel-fill/list", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const workspace = resolveRuntimeWorkspace(claw, adoptId);
      const { root } = ensureExcelRoot(workspace);
      const records = readExcelIndex(root).map((record) => recordForResponse(record, adoptId));
      res.json({ records });
    } catch (err: any) {
      console.error("[office-excel] list error:", err);
      res.status(500).json({ error: err.message || "list failed" });
    }
  });

  app.post("/api/claw/office/excel-fill/plan", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || req.headers["x-adopt-id"] || "").trim();
      const body = (req.body || {}) as any;
      const taskId = safeTaskId(String(body.taskId || crypto.randomUUID()));
      const workbookPath = safeRel(body.workbookPath);
      const contextPaths = Array.isArray(body.contextPaths)
        ? body.contextPaths.map(safeRel).filter(Boolean) as string[]
        : [];
      const instruction = String(body.instruction || "").trim().slice(0, 4000);
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      if (!workbookPath || !EXCEL_EXT_RE.test(workbookPath)) return res.status(400).json({ error: "Excel 文件路径无效" });

      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const workspace = resolveRuntimeWorkspace(claw, adoptId);
      const workbookAbs = safeJoin(workspace, workbookPath);
      if (!workbookAbs || !existsSync(workbookAbs)) return res.status(404).json({ error: "Excel 文件不存在" });
      for (const rel of contextPaths) {
        const abs = safeJoin(workspace, rel);
        if (!abs || !existsSync(abs)) return res.status(404).json({ error: `背景资料不存在: ${rel}` });
      }

      const runtimeAgentId = resolveRuntimeAgentId(adoptId, String((claw as any).agentId || ""));
      const taskDirs = ensureTaskDirs(workspace, taskId);
      const createdAt = new Date().toISOString();
      const requestPath = taskDirs.rel("request.md");
      const planPath = taskDirs.outputRel("fill-plan.md");
      const title = `${safeFileStem(path.basename(workbookPath))} 填表`;
      const requestMd = [
        `# ${title}`,
        "",
        `- 时间：${createdAt}`,
        `- Excel：${workbookPath}`,
        ...contextPaths.map((item) => `- 背景资料：${item}`),
        "",
        "## 填写要求",
        "",
        instruction || "根据背景资料补全 Excel 空白字段，不覆盖已有内容。",
        "",
      ].join("\n");
      writeFileSync(path.join(workspace, requestPath), requestMd, "utf8");

      const prompt = buildPlanPrompt({ taskId, workbookPath, contextPaths, instruction, planPath });
      const plan = await callAgentRuntimeOffice({
        claw,
        runtimeAgentId,
        sessionChannel: "office-excel-plan",
        sessionConversationId: taskId,
        prompt,
        brandSystemPrompt: "你是企业办公 Excel 填表助手，负责把表格、资料和用户要求整理为可审核的填表方案。",
      });
      writeFileSync(path.join(workspace, planPath), `${plan}\n`, "utf8");

      const record: ExcelFillRecord = {
        id: taskId,
        title,
        createdAt,
        updatedAt: new Date().toISOString(),
        status: "planned",
        workbookPath,
        contextPaths,
        instruction,
        requestPath,
        planPath,
        plan,
      };
      upsertRecord(workspace, record);
      res.json({ record: recordForResponse(record, adoptId) });
    } catch (err: any) {
      console.error("[office-excel] plan error:", err);
      res.status(500).json({ error: err.message || "Excel 填表方案生成失败" });
    }
  });

  app.post("/api/claw/office/excel-fill/apply", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || req.headers["x-adopt-id"] || "").trim();
      const taskId = safeTaskId(String((req.body as any)?.taskId || ""));
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      if (!taskId) return res.status(400).json({ error: "taskId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const workspace = resolveRuntimeWorkspace(claw, adoptId);
      const { root } = ensureExcelRoot(workspace);
      const records = readExcelIndex(root);
      const record = records.find((item) => item?.id === taskId);
      if (!record) return res.status(404).json({ error: "Excel 填表任务不存在" });
      if (!record.plan) return res.status(400).json({ error: "请先生成填表方案" });

      const runtimeAgentId = resolveRuntimeAgentId(adoptId, String((claw as any).agentId || ""));
      const taskDirs = ensureTaskDirs(workspace, taskId);
      const resultPath = taskDirs.outputRel("filled.xlsx");
      const resultNotePath = taskDirs.outputRel("fill-result.md");
      const prompt = buildApplyPrompt({
        taskId,
        workbookPath: record.workbookPath,
        contextPaths: record.contextPaths || [],
        instruction: record.instruction || "",
        plan: record.plan,
        resultPath,
        resultNotePath,
      });
      const resultSummary = await callAgentRuntimeOffice({
        claw,
        runtimeAgentId,
        sessionChannel: "office-excel-apply",
        sessionConversationId: taskId,
        prompt,
        brandSystemPrompt: "你是企业办公 Excel 填表执行助手，负责在不覆盖原文件的前提下生成可下载的填表副本。",
        timeoutMs: 300_000,
      });

      const resultAbs = path.join(workspace, resultPath);
      writeFileSync(path.join(workspace, resultNotePath), `${resultSummary}\n`, "utf8");
      const nextRecord: ExcelFillRecord = {
        ...record,
        updatedAt: new Date().toISOString(),
        status: "completed",
        resultPath: existsSync(resultAbs) ? resultPath : undefined,
        resultNotePath,
        resultSummary,
      };
      if (!nextRecord.resultPath) {
        const outputs = listTaskOutputFiles(workspace, taskId);
        const fallback = outputs.find((item) => EXCEL_EXT_RE.test(item));
        if (fallback) nextRecord.resultPath = fallback;
      }
      upsertRecord(workspace, nextRecord);
      res.json({ record: recordForResponse(nextRecord, adoptId) });
    } catch (err: any) {
      console.error("[office-excel] apply error:", err);
      res.status(500).json({ error: err.message || "Excel 写回失败" });
    }
  });
}
