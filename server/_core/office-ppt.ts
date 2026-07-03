import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import pptxgenjs from "pptxgenjs";
import sharp from "sharp";
import {
  APP_ROOT,
  buildRuntimeSessionKey,
  requireClawOwner,
  resolveRuntimeAgentId,
  resolveRuntimeWorkspace,
  sanitizeRelPath,
} from "./helpers";
import { buildChatRequestBody, type PermissionProfile } from "./tool_schema";

type PptCreateRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "planned" | "completed" | "error";
  templateId?: string;
  templateName?: string;
  templatePath: string;
  contextPaths: string[];
  instruction: string;
  requestPath?: string;
  outlinePath?: string;
  resultPath?: string;
  editableResultPath?: string;
  resultNotePath?: string;
  htmlPreviewPath?: string;
  qualityReportPath?: string;
  outline?: string;
  resultSummary?: string;
  error?: string;
};

type PptBlueprintBullet = {
  text: string;
  citationRefs?: string[];
};

type PptBlueprintSlide = {
  pageNo?: number | string;
  type?: string;
  pageRole?: string;
  designPattern?: string;
  title: string;
  keyMessage?: string;
  bullets: PptBlueprintBullet[];
  mustInclude?: string[];
  businessImplications?: string[];
  recommendedActions?: string[];
  evidenceNotes?: string[];
  illustrationPrompt?: string;
  imageSearchQuery?: string;
  visualMetaphor?: string;
  speakerNotes?: string;
  evidence?: string[];
  assumptions?: string[];
  risks?: string[];
  layoutPriority?: string;
  visualIntent?: string;
  visualData?: unknown;
  notes?: string;
};

type PptBlueprint = {
  version?: string;
  title?: string;
  subtitle?: string;
  slides: PptBlueprintSlide[];
};

type DeckTheme = {
  accent: string;
  accent2: string;
  text: string;
  muted: string;
  border: string;
  bg: string;
};

const MAX_RECORDS = 100;
const PPT_EXT_RE = /\.(pptx|ppt)$/i;
const WIDE_SLIDE = { w: 13.333, h: 7.5 };
const BUILTIN_TEMPLATES = [
  {
    id: "huawei-light",
    name: "Huawei 浅色模板",
    description: "浅色商务汇报风格，适合培训、方案和管理汇报。",
    absPath: path.join(APP_ROOT, "data/office-templates/huawei-light.pptx"),
    thumbnailPath: path.join(APP_ROOT, "data/office-templates/huawei-light-thumbnail.jpeg"),
  },
];

export function getBuiltinPptTemplates() {
  return BUILTIN_TEMPLATES.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    available: existsSync(item.absPath),
    thumbnailPath: item.thumbnailPath,
    absPath: item.absPath,
  }));
}

function safeTaskId(input: string) {
  return String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 80) || crypto.randomUUID();
}

function safeFileStem(input: string) {
  return String(input || "ppt-create")
    .replace(/\.[^.]+$/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40) || "ppt-create";
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

function ensurePptRoot(workspace: string) {
  const rootRel = "office/ppt-create";
  const root = path.join(workspace, rootRel);
  mkdirSync(root, { recursive: true });
  return { root, rootRel };
}

function ensureTaskDirs(workspace: string, taskId: string) {
  const safeId = safeTaskId(taskId);
  const relRoot = `office/ppt-create/${safeId}`;
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
    inputRel: (name: string) => `${relRoot}/inputs/${name}`,
    outputRel: (name: string) => `${relRoot}/outputs/${name}`,
  };
}

function readPptIndex(root: string): PptCreateRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, "index.json"), "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePptIndex(root: string, records: PptCreateRecord[]) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "index.json"), JSON.stringify(records.slice(0, MAX_RECORDS), null, 2), "utf8");
}

function upsertRecord(workspace: string, record: PptCreateRecord) {
  const { root } = ensurePptRoot(workspace);
  const records = readPptIndex(root);
  writePptIndex(root, [record, ...records.filter((item) => item?.id !== record.id)]);
  const taskDirs = ensureTaskDirs(workspace, record.id);
  writeFileSync(path.join(taskDirs.absRoot, "meta.json"), JSON.stringify(record, null, 2), "utf8");
}

function deleteRecord(workspace: string, taskId: string) {
  const { root } = ensurePptRoot(workspace);
  const safeId = safeTaskId(taskId);
  const records = readPptIndex(root);
  const nextRecords = records.filter((item) => item?.id !== safeId);
  writePptIndex(root, nextRecords);
  const taskRoot = path.normalize(path.join(root, safeId));
  if ((taskRoot === root || taskRoot.startsWith(root + path.sep)) && existsSync(taskRoot)) {
    rmSync(taskRoot, { recursive: true, force: true });
  }
  return { deleted: records.length !== nextRecords.length };
}

function recordForResponse(record: PptCreateRecord, adoptId: string): PptCreateRecord & {
  outlineUrl?: string;
  resultUrl?: string;
  editableResultUrl?: string;
  resultNoteUrl?: string;
  htmlPreviewUrl?: string;
  qualityReportUrl?: string;
} {
  const download = (rel?: string) => rel
    ? `/api/claw/workspace/files/download?adoptId=${encodeURIComponent(adoptId)}&path=${encodeURIComponent(rel)}`
    : undefined;
  return {
    ...record,
    outlineUrl: download(record.outlinePath),
    resultUrl: download(record.resultPath),
    editableResultUrl: download(record.editableResultPath),
    resultNoteUrl: download(record.resultNotePath),
    htmlPreviewUrl: download(record.htmlPreviewPath),
    qualityReportUrl: download(record.qualityReportPath),
  };
}

function resolveTemplateToWorkspace(args: {
  workspace: string;
  taskId: string;
  templateId?: string;
  templatePath?: string;
}) {
  const taskDirs = ensureTaskDirs(args.workspace, args.taskId);
  const templateId = String(args.templateId || "huawei-light").trim();
  if (args.templatePath) {
    const rel = safeRel(args.templatePath);
    if (!rel || !PPT_EXT_RE.test(rel)) throw new Error("模板文件路径无效");
    const abs = safeJoin(args.workspace, rel);
    if (!abs || !existsSync(abs)) throw new Error("模板文件不存在");
    return { templateId: "custom", templateName: path.basename(rel), templatePath: rel };
  }
  const builtin = BUILTIN_TEMPLATES.find((item) => item.id === templateId) || BUILTIN_TEMPLATES[0];
  if (!existsSync(builtin.absPath)) throw new Error(`内置模板不存在: ${builtin.id}`);
  const rel = taskDirs.inputRel(`template-${builtin.id}.pptx`);
  copyFileSync(builtin.absPath, path.join(args.workspace, rel));
  return { templateId: builtin.id, templateName: builtin.name, templatePath: rel };
}

async function callOpenClawOffice(args: {
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
        if (!text) reject(new Error("OpenClaw 返回结果为空"));
        else resolve(text);
      });
    });
    req.on("error", reject);
    req.setTimeout(args.timeoutMs || 300_000, () => req.destroy(new Error("OpenClaw PPT 处理超时")));
    req.write(body);
    req.end();
  });
}

async function streamOpenClawOffice(args: {
  claw: any;
  runtimeAgentId: string;
  sessionChannel: string;
  sessionConversationId: string;
  prompt: string;
  brandSystemPrompt: string;
  timeoutMs?: number;
  onDelta: (text: string) => void;
  onEvent?: (event: string, payload: any) => void;
  onRequest?: (req: http.ClientRequest) => void;
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
    }, (upstream) => {
      let buffer = "";
      let currentEvent = "";
      let out = "";
      upstream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const blocks = buffer.split(/\n\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          for (const rawLine of block.split("\n")) {
            const line = rawLine.trimEnd();
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
              continue;
            }
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            if (data === "[DONE]") {
              args.onEvent?.("upstream_done", {});
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              if (currentEvent && currentEvent !== "message") {
                args.onEvent?.(currentEvent, parsed);
              }
              const delta = parsed?.choices?.[0]?.delta?.content
                || parsed?.choices?.[0]?.delta?.reasoning_content
                || "";
              if (delta) {
                out += delta;
                args.onDelta(delta);
              } else if (parsed?.__stream_error || parsed?.error) {
                args.onEvent?.("upstream_error", parsed);
              }
            } catch {
              args.onEvent?.("raw", { event: currentEvent, data });
            } finally {
              currentEvent = "";
            }
          }
        }
      });
      upstream.on("end", () => {
        const text = out.trim();
        if (!text) reject(new Error("OpenClaw 返回结果为空"));
        else resolve(text);
      });
    });
    args.onRequest?.(req);
    req.on("error", reject);
    req.setTimeout(args.timeoutMs || 300_000, () => req.destroy(new Error("OpenClaw PPT 处理超时")));
    req.write(body);
    req.end();
  });
}

function buildOutlinePrompt(args: {
  templateName: string;
  templatePath: string;
  contextPaths: string[];
  instruction: string;
  outlinePath: string;
}) {
  return [
    "你是企业办公 PPT 策划助手。请先生成可审核的 PPT 分页大纲，不要生成 PPTX 文件。",
    "",
    "技能要求：",
    "1. 必须使用或遵循 `office-ppt-outline` 技能的方法论来规划故事线、分页结构和视觉建议。",
    "2. 如果当前运行时提供技能读取工具，请先读取 `office-ppt-outline` 的 SKILL.md；如果无法读取，则按本提示继续。",
    "3. 这是办公空间的结构化 PPT 流程：本阶段只生成大纲和机器可读蓝图，后续由 employee-agent 生成 PPTX。",
    "4. 不要停下来向用户追问。信息不足时，在「需要用户补充的信息」列出缺口，并基于明确假设继续生成可预览初稿。",
    "5. 如果有输入材料，先读取/分析材料，再生成大纲；不要只根据文件名猜测内容。",
    "",
    "设计原则：",
    "1. 先保证结构清晰、信息准确，再考虑视觉表达。",
    "2. 只基于用户材料和要求生成，不要编造事实。",
    "3. 按模板风格规划内容：标题短、要点少、页面有层次。",
    "4. 每页建议 3-5 个要点，避免长段落。",
    "5. 明确哪些页面需要图表、图片或数据补充。",
    "6. 如果用户要求热点话题、最新趋势、近期事件，且没有上传足够材料，你可以使用可用的网页搜索/网页抓取工具先检索资料；如果当前环境没有搜索工具，请在「需要用户补充的信息」中说明证据不足。",
    "7. 进行热点/最新类搜索时，大纲必须保留来源标题、URL、日期和不确定性，不要把搜索摘要当成已验证事实。",
    "",
    `模板：${args.templateName}`,
    `模板文件：${args.templatePath}`,
    "",
    "输入材料：",
    ...(args.contextPaths.length ? args.contextPaths.map((item) => `- ${item}`) : ["- 无上传材料，仅根据用户要求生成"]),
    "",
    "用户要求：",
    args.instruction || "生成一份 8 页左右的商务汇报 PPT，风格简洁专业。",
    "",
    "请输出 Markdown，固定包含以下章节：",
    "# PPT 大纲",
    "## 任务理解",
    "## 整体结构",
    "## 分页方案",
    "每页用：页码、页面类型、标题、核心内容、视觉建议、备注。",
    "每页核心内容必须写成可直接落盘的汇报内容：一句结论 + 3-5 个支撑要点；不要只写抽象标签。",
    "每页还要补齐：关键证据/来源线索、业务含义、建议动作。即使最终页面压缩展示，文字大纲也要足够丰富，方便后续按要求落盘。",
    "趋势洞察类页面必须包含：事实/信号、背后原因、对企业的影响、可验证的下一步。",
    "行动建议类页面必须包含：优先级、牵头对象、衡量指标、风险或依赖条件。",
    "如果资料足够丰富，先在文字大纲里展开逻辑和证据，再由 PPT_BLUEPRINT_JSON 压缩为页面内容。",
    "如果某页是图表页，也必须写清图表要表达的结论和页面正文，不要只给 visualData。",
    "## 需要用户补充的信息",
    "## 生成规则",
    "## PPT_BLUEPRINT_JSON",
    "最后必须追加一个 fenced code block，语言标记必须是 PPT_BLUEPRINT_JSON，供系统生成 PPTX 文件。",
    "JSON 格式：",
    "```PPT_BLUEPRINT_JSON",
    JSON.stringify({
      version: "v1",
      title: "演示文稿标题",
      subtitle: "副标题或使用场景",
      slides: [
        {
          pageNo: 1,
          type: "cover",
          title: "四字标签：清晰观点标题",
          keyMessage: "本页一句话主张",
          bullets: [{ text: "精炼论据或页面内容", citationRefs: [] }],
          mustInclude: ["必须进入最终 PPT 的关键判断或事实"],
          businessImplications: ["本页结论对企业、业务、组织或管理的直接启示"],
          recommendedActions: ["如果是行动类页面，写可执行的下一步或决策建议"],
          evidenceNotes: ["支撑本页判断的证据、案例、对比或来源线索"],
          illustrationPrompt: "适合本页的概念插图描述，例如：企业流程中多个 Agent 协同处理任务",
          imageSearchQuery: "如确实需要真实图片，给出可搜索的中英文关键词；没有必要则留空",
          visualMetaphor: "可用于生成抽象插图的视觉隐喻，例如：流程编排、风险护栏、能力底座",
          speakerNotes: "给汇报人的讲述口径，不直接堆进页面正文",
          evidence: ["来源名称 | 来源标题 | URL | 日期"],
          assumptions: ["信息不足时采用的明确假设"],
          risks: ["需要人工复核的不确定点"],
          layoutPriority: "content",
          visualIntent: "kpi-cards",
          visualData: {
            items: [
              { label: "指标或阶段", value: "数值/状态", note: "简短说明" },
            ],
          },
          notes: "给生成器的版式提醒",
        },
      ],
    }),
    "```",
    "PPT_BLUEPRINT_JSON 规则：",
    "- slides 必须与分页方案逐页一致：页数一致、标题一致、核心观点一致。",
    "- title 要短，优先使用「四字标签：观点」格式。",
    "- bullets 每页 4-6 条，每条要短；不要写长段落。",
    "- 内容优先：每页必须先有清晰结论，再有支撑要点；图表只能辅助表达，不能替代正文。",
    "- mustInclude 用于列出必须落到最终 PPT 的关键事实/判断；它应当和 bullets 保持一致或互相补充。",
    "- businessImplications 写本页对企业、业务、组织或管理的启示；recommendedActions 写可执行动作；evidenceNotes 写支撑本页判断的证据线索。以上字段会参与最终 PPT 内容落盘。",
    "- 内容密度标准：除封面外，每页至少形成 6-8 个可落盘信息点，优先顺序为 keyMessage、mustInclude、bullets、businessImplications、recommendedActions、evidenceNotes；不要只写概念词。",
    "- 领导汇报标准：每页都要回答“所以什么”：事实/趋势是什么、为什么重要、对企业意味着什么、下一步怎么做。信息不足时写清假设和待复核项，不要编造。",
    "- 配图标准：需要视觉填充时，优先写 illustrationPrompt 和 visualMetaphor，用于生成抽象业务插图或概念图；只有真实人物、地点、产品、活动现场等必须真实呈现时，才写 imageSearchQuery，并注明需要核验版权和来源。",
    "- speakerNotes 写汇报口径；evidence 写来源名称、标题、URL、日期；assumptions/risks 写假设和待复核点。可信度、抓取日期、不确定性只放在大纲/备注里，不进入最终 PPT 页面。",
    "- 如果大纲信息丰富，PPT 页面应优先保留 keyMessage、mustInclude、bullets、businessImplications 和 recommendedActions 的主旨，再压缩细节。",
    "- visualIntent 从 cover、agenda、content-cards、compare-two-column、process-flow、timeline、matrix-2x2、kpi-cards、bar-chart、table、summary 中选择最接近的一种。",
    "- 如果页面适合图表，必须提供 visualData.items；每个 item 使用 label、value、note 三个字段。",
    "- visualData.items 要写成可直接上屏的结构化内容，不要只写抽象名词。agenda/timeline/process 至少 4 项，table 至少 4 行，matrix 必须 4 象限，summary 至少 4 张决策卡。",
    "- content-cards 页的 visualData.items 应承载右侧卡片：label 写维度，value 写短判断，note 写补充说明；不要与 bullets 完全重复。",
    "- compare-two-column 页必须在 visualData.items 中给出左右两栏的 label/value/note，左栏通常是现状/问题/依据，右栏通常是目标/建议/变化。",
    "- summary 页不要写泛泛口号，必须覆盖方向、投入、节奏、指标、风险/依赖、下一步中的至少 4 项。",
    "- recommendedActions 要具体到动作、对象、时间或指标，例如“2 周内完成核心知识源盘点”，不要写“持续优化、加强建设”这类空泛表述。",
    "- 涉及热点/最新信息时，bullet 或 note 中保留简洁来源引用线索，不能编造日期、机构或数字；最终页面脚注只展示简洁来源名，不展示“较可信、待复核、抓取日期”等审稿备注。",
    "- 不要把 PPT_BLUEPRINT_JSON 当作说明文字省略；后端会直接解析它生成 PPTX。",
    "",
    `平台会把最终大纲保存为工作空间文件：${args.outlinePath}`,
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function compactText(value: unknown, max = 180) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\uFFFD/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeDeckText(value: unknown, max = 240) {
  return compactText(value, max);
}

function htmlEscape(value: unknown) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function svgEscape(value: unknown) {
  return htmlEscape(value);
}

function wrapTextLines(value: unknown, maxChars: number, maxLines: number) {
  const source = normalizeDeckText(value, 500);
  if (!source) return [];
  const lines: string[] = [];
  let current = "";
  for (const ch of source) {
    const next = current + ch;
    const width = Array.from(next).reduce((sum, item) => sum + (/[\x00-\x7F]/.test(item) ? 0.55 : 1), 0);
    if (width > maxChars && current) {
      lines.push(current);
      current = ch;
      if (lines.length >= maxLines) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && source.length > lines.join("").length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[。；，、,. ]+$/g, "")}...`;
  }
  return lines;
}

function svgTextBlock(args: {
  text: unknown;
  x: number;
  y: number;
  widthChars: number;
  maxLines: number;
  size: number;
  color?: string;
  weight?: number;
  lineHeight?: number;
}) {
  const lineHeight = args.lineHeight || Math.round(args.size * 1.45);
  return wrapTextLines(args.text, args.widthChars, args.maxLines)
    .map((line, index) => `<text x="${args.x}" y="${args.y + index * lineHeight}" font-size="${args.size}" font-weight="${args.weight || 400}" fill="${args.color || "#111827"}">${svgEscape(line)}</text>`)
    .join("");
}

function normalizeHexColor(value: unknown) {
  const hex = String(value || "").replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase();
  return hex.length === 6 ? `#${hex}` : "";
}

function colorDistance(a: string, b: string) {
  const ah = a.replace("#", "");
  const bh = b.replace("#", "");
  if (ah.length !== 6 || bh.length !== 6) return 0;
  const ar = parseInt(ah.slice(0, 2), 16);
  const ag = parseInt(ah.slice(2, 4), 16);
  const ab = parseInt(ah.slice(4, 6), 16);
  const br = parseInt(bh.slice(0, 2), 16);
  const bg = parseInt(bh.slice(2, 4), 16);
  const bb = parseInt(bh.slice(4, 6), 16);
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
}

function isUsefulAccent(color: string) {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 70 || min > 235) return false;
  return max - min > 28;
}

function resolveDeckTheme(templateName: string, templateAbs?: string): DeckTheme {
  const fallback: DeckTheme = {
    accent: /huawei|华为/i.test(templateName || "") ? "#c7000b" : "#2563eb",
    accent2: "#0f766e",
    text: "#111827",
    muted: "#64748b",
    border: "#e5e7eb",
    bg: "#f8fafc",
  };
  if (!templateAbs || !existsSync(templateAbs)) return fallback;
  try {
    const xml = execFileSync("unzip", ["-p", templateAbs, "ppt/theme/theme1.xml"], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    const accents = Array.from(xml.matchAll(/<a:accent\d>[\s\S]*?<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/g))
      .map((match) => normalizeHexColor(match[1]))
      .filter(isUsefulAccent);
    const accent = accents[0] || fallback.accent;
    const secondary = accents.find((color) => colorDistance(color, accent) > 90) || fallback.accent2;
    return { ...fallback, accent, accent2: secondary };
  } catch {
    return fallback;
  }
}

function normalizeBullet(item: unknown): PptBlueprintBullet | null {
  if (typeof item === "string") {
    const text = compactText(item, 180);
    return text ? { text } : null;
  }
  const record = asRecord(item);
  if (!record) return null;
  const text = compactText(record.text || record.title || record.content || record.point, 180);
  if (!text) return null;
  const citationRefs = Array.isArray(record.citationRefs)
    ? record.citationRefs.map((ref) => compactText(ref, 120)).filter(Boolean)
    : undefined;
  return { text, citationRefs };
}

function findSlideArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return null;
  if (Array.isArray(record.slides)) return record.slides;
  for (const key of ["pptBlueprint", "deckBlueprint", "blueprint", "deck"]) {
    const nested = findSlideArray(record[key]);
    if (nested) return nested;
  }
  return null;
}

function normalizeBlueprint(value: unknown, fallbackTitle: string): PptBlueprint | null {
  const slides = findSlideArray(value);
  if (!slides?.length) return null;
  const record = asRecord(value) || {};
  const normalizedSlides = slides
    .map((item, index): PptBlueprintSlide | null => {
      const slide = asRecord(item);
      if (!slide) return null;
      const title = compactText(slide.title || slide.heading || slide.name || `第 ${index + 1} 页`, 80);
      const rawBullets = Array.isArray(slide.bullets)
        ? slide.bullets
        : Array.isArray(slide.items)
          ? slide.items
          : Array.isArray(slide.points)
            ? slide.points
            : [];
      const bullets = rawBullets.map(normalizeBullet).filter(Boolean) as PptBlueprintBullet[];
      const keyMessage = compactText(slide.keyMessage || slide.message || slide.summary || slide.core || "", 180);
      if (!bullets.length && keyMessage) bullets.push({ text: keyMessage });
      const listText = (value: unknown, max = 180) => Array.isArray(value)
        ? value.map((item) => compactText(typeof item === "string" ? item : asRecord(item)?.text || asRecord(item)?.title || asRecord(item)?.content || item, max)).filter(Boolean).slice(0, 8)
        : [];
      return {
        pageNo: typeof slide.pageNo === "number" || typeof slide.pageNo === "string" ? slide.pageNo : index + 1,
        type: compactText(slide.type || slide.layout || "", 40),
        title,
        keyMessage,
        bullets: bullets.slice(0, 6),
        mustInclude: listText(slide.mustInclude || slide.must || slide.required || slide.keyFacts, 180),
        businessImplications: listText(slide.businessImplications || slide.implications || slide.businessMeaning || slide.enterpriseImplications, 180),
        recommendedActions: listText(slide.recommendedActions || slide.actions || slide.nextSteps || slide.decisions, 180),
        evidenceNotes: listText(slide.evidenceNotes || slide.proofPoints || slide.supportingEvidence || slide.evidenceSummary, 180),
        illustrationPrompt: compactText(slide.illustrationPrompt || slide.imagePrompt || slide.visualPrompt || "", 220),
        imageSearchQuery: compactText(slide.imageSearchQuery || slide.searchImageQuery || slide.imageQuery || "", 160),
        visualMetaphor: compactText(slide.visualMetaphor || slide.metaphor || "", 120),
        speakerNotes: compactText(slide.speakerNotes || slide.presenterNotes || "", 360),
        evidence: listText(slide.evidence || slide.sources || slide.citations, 180),
        assumptions: listText(slide.assumptions, 160),
        risks: listText(slide.risks || slide.uncertainties, 160),
        layoutPriority: compactText(slide.layoutPriority || "", 24),
        visualIntent: compactText(slide.visualIntent || slide.visual || slide.layoutHint || "", 60),
        visualData: slide.visualData || slide.data || slide.chartData || slide.itemsData || null,
        notes: compactText(slide.notes || slide.remark || "", 240),
      };
    })
    .filter(Boolean) as PptBlueprintSlide[];
  if (!normalizedSlides.length) return null;
  return {
    version: compactText(record.version || "v1", 20),
    title: compactText(record.title || normalizedSlides[0]?.title || fallbackTitle, 80),
    subtitle: compactText(record.subtitle || record.description || "", 120),
    slides: normalizedSlides.slice(0, 20),
  };
}

function extractBlueprintFromOutline(outline: string, fallbackTitle: string): PptBlueprint | null {
  const fencePattern = /```(?:\s*(?:PPT_BLUEPRINT_JSON|ppt_blueprint_json|json))?\s*\n([\s\S]*?)```/g;
  for (const match of outline.matchAll(fencePattern)) {
    const body = match[1]?.trim();
    if (!body || !/"slides"|"pptBlueprint"|"deckBlueprint"/.test(body)) continue;
    try {
      const parsed = JSON.parse(body);
      const blueprint = normalizeBlueprint(parsed, fallbackTitle);
      if (blueprint) return blueprint;
    } catch {}
  }

  const directJson = outline.match(/\{[\s\S]*"slides"[\s\S]*\}/);
  if (directJson) {
    try {
      const blueprint = normalizeBlueprint(JSON.parse(directJson[0]), fallbackTitle);
      if (blueprint) return blueprint;
    } catch {}
  }
  return null;
}

function fallbackBlueprintFromMarkdown(outline: string, fallbackTitle: string): PptBlueprint {
  const pagePlan = outline.match(/##\s*分页方案([\s\S]*?)(?:\n##\s|$)/)?.[1] || outline;
  const pageSegments = pagePlan.match(/(?:^|\n)#{2,4}\s*第\s*\d+\s*页[\s\S]*?(?=(?:\n#{2,4}\s*第\s*\d+\s*页)|$)/g);
  const segments = (pageSegments?.length ? pageSegments : pagePlan
    .split(/\n(?=(?:#{1,4}\s*)?(?:第\s*\d+\s*页|页码\s*[:：]?\s*\d+))/g))
    .map((item) => item.trim())
    .filter(Boolean);
  const slides = segments
    .map((segment, index): PptBlueprintSlide | null => {
      const lines = segment.split("\n").map((line) => line.trim()).filter(Boolean);
      if (!lines.length) return null;
      const titleLine = lines.find((line) => /^[-*•]\s*标题\s*[:：]/.test(line))
        || lines.find((line) => /^标题\s*[:：]/.test(line))
        || lines[0];
      const title = compactText(titleLine
        .replace(/^#{1,4}\s*/, "")
        .replace(/^(?:第\s*\d+\s*页|页码\s*[:：]?\s*\d+|\d+[.、])\s*[:：-]?/, "")
        .replace(/^[-*•]\s*/, "")
        .replace(/^标题\s*[:：]/, ""), 80);
      const contentStart = lines.findIndex((line) => /^[-*•]\s*核心内容\s*[:：]/.test(line) || /^核心内容\s*[:：]/.test(line));
      const visualLine = lines.find((line) => /^[-*•]\s*视觉建议\s*[:：]/.test(line) || /^视觉建议\s*[:：]/.test(line));
      const contentLines = contentStart >= 0
        ? lines.slice(contentStart + 1)
          .filter((line) => !/^[-*•]\s*(视觉建议|备注)\s*[:：]/.test(line) && !/^(视觉建议|备注)\s*[:：]/.test(line))
        : lines.filter((line) => /^[-*•]\s+/.test(line));
      const bulletLines = contentLines
        .filter((line) => /^[-*•]\s+/.test(line))
        .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^(?:核心内容|要点)\s*[:：]/, ""))
        .map((line) => compactText(line, 160))
        .filter(Boolean)
        .slice(0, 5);
      return {
        pageNo: index + 1,
        title: title || `第 ${index + 1} 页`,
        keyMessage: bulletLines[0] || "",
        bullets: bulletLines.slice(0, 5).map((text) => ({ text })),
        visualIntent: visualLine ? compactText(visualLine, 60) : index === 0 ? "cover" : "content-cards",
      };
    })
    .filter(Boolean) as PptBlueprintSlide[];

  if (slides.length >= 2) return { version: "fallback", title: fallbackTitle, slides: slides.slice(0, 12) };
  return {
    version: "fallback",
    title: fallbackTitle,
    slides: [
      { pageNo: 1, type: "cover", title: fallbackTitle, keyMessage: "基于用户要求生成的商务汇报", bullets: [], visualIntent: "cover" },
      { pageNo: 2, type: "agenda", title: "汇报结构", bullets: [{ text: "背景与目标" }, { text: "核心分析" }, { text: "行动建议" }], visualIntent: "agenda" },
      { pageNo: 3, title: "核心内容", keyMessage: compactText(outline, 180), bullets: [{ text: compactText(outline, 180) }], visualIntent: "content-cards" },
      { pageNo: 4, title: "下一步动作", bullets: [{ text: "补充关键数据和案例" }, { text: "确认行动计划与负责人" }, { text: "形成最终汇报版本" }], visualIntent: "summary" },
    ],
  };
}

export function resolveBlueprint(outline: string, fallbackTitle: string): PptBlueprint {
  return extractBlueprintFromOutline(outline, fallbackTitle) || fallbackBlueprintFromMarkdown(outline, fallbackTitle);
}

function splitTitle(title: string) {
  const parts = title.split(/[:：]/);
  if (parts.length >= 2 && parts[0] && parts.slice(1).join("：")) {
    return { label: compactText(parts[0], 12), main: compactText(parts.slice(1).join("："), 72) };
  }
  return { label: "", main: compactText(title, 72) };
}

function slideKind(slide: PptBlueprintSlide, index: number, total: number) {
  const intent = `${slide.pageRole || ""} ${slide.designPattern || ""} ${slide.type || ""} ${slide.visualIntent || ""} ${slide.title || ""}`.toLowerCase();
  const visual = `${slide.designPattern || ""} ${slide.visualIntent || ""} ${slide.notes || ""}`.toLowerCase();
  const pageType = `${slide.pageRole || ""} ${slide.designPattern || ""} ${slide.type || ""}`.toLowerCase();
  const dataItems = visualItems(slide, "").filter((item) => item.label || item.value || item.note);
  if (index === 0 || /cover/.test(intent)) return "cover";
  if (/thesis/.test(intent)) return "summary";
  if (/evidence-boundary/.test(intent)) return "table";
  if (/concept-breakdown/.test(intent)) return "process";
  if (/analogy-map/.test(intent)) return "compare";
  if (/scenario-matrix/.test(intent)) return "matrix";
  if (/capability-stack/.test(intent)) return "kpi";
  if (/risk-controls/.test(intent)) return "kpi";
  if (/decision-summary/.test(intent)) return "summary";
  if (/agenda/.test(intent)) return "agenda";
  if (/executive-summary|executive|summary/.test(intent)) return "summary";
  if (/three-points|three_points|三观点|三点|三条/.test(intent)) return "kpi";
  if (/timeline|roadmap|路标|路线图|里程碑|第\d|周|month|quarter/.test(visual) || /roadmap|timeline|路线图|路标|行动路线/.test(pageType)) return "timeline";
  if (/table|治理|清单|分级|列表/.test(visual) || /table|governance|risk|治理|风险/.test(pageType)) return "table";
  if (/matrix|2x2|quadrant|四象限|矩阵|价值.*风险|优先级/.test(visual) || /scenario|priority|场景|优先级/.test(pageType)) return "matrix";
  if (dataItems.length >= 4 && dataItems.every((item) => /第\d|周|月|阶段|phase|p\d/i.test(`${item.label} ${item.value}`))) return "timeline";
  if (dataItems.length >= 4 && /风险|价值|优先|象限|矩阵/.test(dataItems.map((item) => `${item.label}${item.value}${item.note}`).join(" "))) return "matrix";
  if (index === 0 || /cover|封面/.test(intent)) return "cover";
  if (/agenda|目录/.test(intent)) return "agenda";
  if (/executive-summary|executive|summary|结论|总结|结束/.test(intent)) return "summary";
  if (/three-points|three_points|三观点|三点|三条/.test(intent)) return "kpi";
  if (/kpi|metric|number|数字|指标/.test(intent)) return "kpi";
  if (/timeline|roadmap|时间轴|里程碑|路线图/.test(intent)) return "timeline";
  if (/matrix|2x2|四象限|矩阵|swot/.test(intent)) return "matrix";
  if (/bar-chart|bar|柱状|条形/.test(intent)) return "bar";
  if (/compare|two-column|对比|as-is|to-be/.test(intent)) return "compare";
  if (/process|flow|timeline|步骤|流程|路径|计划/.test(intent)) return "process";
  if (/table|matrix|表格|矩阵/.test(intent)) return "table";
  return "content";
}

function displayLimitForKind(kind: string) {
  if (kind === "process") return 4;
  if (kind === "compare") return 6;
  if (kind === "summary") return 4;
  if (kind === "matrix") return 4;
  if (kind === "kpi") return 4;
  if (kind === "table") return 5;
  return 5;
}

function addFooter(slide: any, pageNo: number, total: number, theme: { muted: string; accent: string }) {
  slide.addShape("line", { x: 0.6, y: 7.03, w: 12.1, h: 0, line: { color: "E5E7EB", width: 0.8 } });
  slide.addText(`${pageNo}/${total}`, { x: 11.65, y: 7.08, w: 0.95, h: 0.2, fontFace: "Microsoft YaHei", fontSize: 8, color: theme.muted, align: "right" });
  slide.addShape("rect", { x: 0.6, y: 7.1, w: 0.25, h: 0.05, fill: { color: theme.accent }, line: { color: theme.accent } });
}

function addCitationFooter(slide: any, item: PptBlueprintSlide, theme: { muted: string }) {
  const refs = collectCitationRefs(item);
  if (!refs.length) return;
  slide.addText(`来源：${refs.join(" · ")}`, {
    x: 0.88,
    y: 6.72,
    w: 10.2,
    h: 0.18,
    fontFace: "Microsoft YaHei",
    fontSize: 6.8,
    color: theme.muted,
    fit: "shrink",
  });
}

function addSlideTitle(slide: any, item: PptBlueprintSlide, theme: { text: string; muted: string; accent: string }) {
  const title = splitTitle(item.title);
  if (title.label) {
    slide.addText(title.label, { x: 0.75, y: 0.42, w: 1.2, h: 0.28, fontFace: "Microsoft YaHei", fontSize: 8.5, bold: true, color: "FFFFFF", margin: 0.04, align: "center", fill: { color: theme.accent }, breakLine: false });
    slide.addText(title.main, { x: 2.1, y: 0.36, w: 10.2, h: 0.45, fontFace: "Microsoft YaHei", fontSize: 18.5, bold: true, color: theme.text, fit: "shrink" });
  } else {
    slide.addText(title.main, { x: 0.75, y: 0.34, w: 11.6, h: 0.52, fontFace: "Microsoft YaHei", fontSize: 19, bold: true, color: theme.text, fit: "shrink" });
  }
  if (item.keyMessage) {
    slide.addText(item.keyMessage, { x: 0.77, y: 0.94, w: 11.75, h: 0.36, fontFace: "Microsoft YaHei", fontSize: 9, color: theme.muted, fit: "shrink" });
  }
}

function displayBullets(slide: PptBlueprintSlide, fallback = "待补充") {
  const requiredRows = (slide.mustInclude || []).map((text) => ({ text }));
  const implicationRows = (slide.businessImplications || []).map((text) => ({ text }));
  const actionRows = (slide.recommendedActions || []).map((text) => ({ text }));
  const evidenceRows = (slide.evidenceNotes || []).map((text) => ({ text }));
  const rows = slide.bullets?.length || requiredRows.length || implicationRows.length || actionRows.length || evidenceRows.length
    ? [...requiredRows, ...(slide.bullets || []), ...implicationRows, ...actionRows, ...evidenceRows]
    : [{ text: slide.keyMessage || fallback }];
  const seen = new Set<string>();
  const normalizedKey = compactText(slide.keyMessage, 180);
  return rows.filter((item, index) => {
    const text = compactText(item.text, 180);
    if (!text) return false;
    if (index === 0 && normalizedKey && text === normalizedKey && rows.length > 1) return false;
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function bulletText(slide: PptBlueprintSlide, fallback = "待补充") {
  const rows = displayBullets(slide, fallback);
  return rows.slice(0, 4).map((item) => `• ${compactText(item.text, 72)}`).join("\n");
}

function visualItems(slide: PptBlueprintSlide, fallback = "待补充") {
  const data = asRecord(slide.visualData);
  const candidates = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.metrics)
      ? data.metrics
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(slide.visualData)
          ? slide.visualData
          : [];
  const rows = candidates
    .map((item, index) => {
      if (typeof item === "string") {
        return { label: `项 ${index + 1}`, value: compactText(item, 48), note: "" };
      }
      const row = asRecord(item);
      if (!row) return null;
      const label = compactText(row.label || row.name || row.title || row.stage || row.category || `项 ${index + 1}`, 42);
      const value = compactText(row.value || row.metric || row.amount || row.status || row.date || "", 42);
      const note = compactText(row.note || row.desc || row.description || row.text || row.detail || "", 92);
      return label || value || note ? { label, value, note } : null;
    })
    .filter(Boolean) as Array<{ label: string; value: string; note: string }>;
  if (rows.length) return rows.slice(0, 8);
  return displayBullets(slide, fallback).map((item, index) => ({
    label: `要点 ${index + 1}`,
    value: "",
    note: compactText(item.text, 92),
  })).slice(0, 8);
}

function numericValue(value: string, fallback: number) {
  const match = String(value || "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return fallback;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanCitationForSlide(ref: unknown) {
  const raw = normalizeDeckText(ref, 220);
  if (!raw || /^E\d+$/i.test(raw)) return "";
  const parts = raw
    .split(/\s*\|\s*|\s+·\s+|\s+-\s+/)
    .map((part) => normalizeDeckText(part, 80))
    .filter(Boolean)
    .filter((part) => !/^https?:\/\//i.test(part))
    .filter((part) => !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(part))
    .filter((part) => !/(可信|较可信|不确定|待复核|抓取|页面未显示|发布日期|需核验|备注|用于|来源线索)/.test(part));
  const preferred = parts
    .filter((part) => !/(报告|数据|调研|官方|来源|source)/i.test(part) || parts.length <= 2)
    .slice(0, 2);
  return compactText((preferred.length ? preferred : parts).slice(0, 2).join(" · "), 90);
}

function collectCitationRefs(slide: PptBlueprintSlide) {
  const refs = new Set<string>();
  for (const item of slide.bullets || []) {
    for (const ref of item.citationRefs || []) {
      const cleaned = cleanCitationForSlide(ref);
      if (cleaned) refs.add(cleaned);
    }
  }
  for (const ref of slide.evidence || []) {
    const cleaned = cleanCitationForSlide(ref);
    if (cleaned) refs.add(cleaned);
  }
  for (const ref of slide.evidenceNotes || []) {
    const cleaned = cleanCitationForSlide(ref);
    if (cleaned && /https?:\/\/|来源|source|Sequoia|官方|报告|数据|调研/i.test(cleaned)) refs.add(cleaned);
  }
  return Array.from(refs).slice(0, 3);
}

function conceptVisualText(slide: PptBlueprintSlide) {
  return compactText(
    slide.visualMetaphor
      || slide.illustrationPrompt
      || slide.imageSearchQuery,
    120,
  );
}

function supportingInsightRows(
  slide: PptBlueprintSlide,
  fallbackRows: Array<{ text: string }>,
  max = 3,
) {
  const pools: Array<Array<string | undefined>> = [
    slide.recommendedActions || [],
    slide.businessImplications || [],
    slide.risks || [],
    slide.assumptions || [],
    fallbackRows.map((item) => item.text),
  ];
  const title = compactText(slide.title, 120);
  const key = compactText(slide.keyMessage, 180);
  const seen = new Set<string>();
  const rows: Array<{ text: string }> = [];
  for (const pool of pools) {
    for (const raw of pool) {
      const textValue = compactText(raw, 140);
      if (!textValue) continue;
      if (textValue === title || textValue === key) continue;
      if (seen.has(textValue)) continue;
      seen.add(textValue);
      rows.push({ text: textValue });
      if (rows.length >= max) return rows;
    }
  }
  return rows;
}

function renderConceptIllustration(args: {
  slide: PptBlueprintSlide;
  x: number;
  y: number;
  w: number;
  h: number;
  accent: string;
  accent2: string;
  border: string;
  muted: string;
  text: string;
}) {
  const label = conceptVisualText(args.slide);
  if (!label) return "";
  const words = label ? label.split(/[，、,;；\s]+/).filter(Boolean).slice(0, 4) : ["趋势", "场景", "治理", "行动"];
  if (args.h < 110) {
    const pillW = Math.min(150, Math.max(96, (args.w - 180) / Math.max(1, words.length)));
    return `<g>
      <rect x="${args.x}" y="${args.y}" width="${args.w}" height="${args.h}" rx="16" fill="#fff" stroke="${args.border}"/>
      ${label ? svgTextBlock({ text: label, x: args.x + 28, y: args.y + 34, widthChars: 34, maxLines: 1, size: 13, color: args.muted }) : ""}
      ${words.map((word, i) => {
        const x = args.x + 360 + i * (pillW + 18);
        const color = i % 2 ? args.accent2 : args.accent;
        return `<rect x="${x}" y="${args.y + 28}" width="${pillW}" height="34" rx="17" fill="#f8fafc" stroke="${color}" stroke-width="1.5"/>
          <circle cx="${x + 20}" cy="${args.y + 45}" r="5" fill="${color}"/>
          ${svgTextBlock({ text: word, x: x + 34, y: args.y + 50, widthChars: 8, maxLines: 1, size: 12, weight: 700, color: args.text })}`;
      }).join("")}
    </g>`;
  }
  const cx = args.x + args.w / 2;
  const cy = args.y + args.h / 2;
  const nodes = [
    { x: args.x + args.w * 0.24, y: args.y + args.h * 0.35, color: args.accent },
    { x: args.x + args.w * 0.62, y: args.y + args.h * 0.28, color: args.accent2 },
    { x: args.x + args.w * 0.77, y: args.y + args.h * 0.68, color: args.accent },
    { x: args.x + args.w * 0.34, y: args.y + args.h * 0.72, color: args.accent2 },
  ];
  return `<g>
    <rect x="${args.x}" y="${args.y}" width="${args.w}" height="${args.h}" rx="18" fill="#fff" stroke="${args.border}"/>
    <circle cx="${cx}" cy="${cy}" r="${Math.min(args.w, args.h) * 0.22}" fill="#f8fafc" stroke="${args.border}" stroke-width="2"/>
    ${nodes.map((node, i) => `<line x1="${cx}" y1="${cy}" x2="${node.x}" y2="${node.y}" stroke="${args.border}" stroke-width="2"/>
      <circle cx="${node.x}" cy="${node.y}" r="18" fill="${node.color}"/>
      ${svgTextBlock({ text: words[i] || `要点${i + 1}`, x: node.x - 44, y: node.y + 46, widthChars: 8, maxLines: 1, size: 12, weight: 700, color: args.text })}`).join("")}
    <text x="${cx}" y="${cy + 7}" text-anchor="middle" font-size="18" font-weight="700" fill="${args.text}">AI</text>
    ${label ? svgTextBlock({ text: label, x: args.x + 28, y: args.y + args.h - 24, widthChars: 32, maxLines: 1, size: 13, color: args.muted }) : ""}
  </g>`;
}

function renderInsightStrip(args: {
  bullets: Array<{ text: string }>;
  x: number;
  y: number;
  w: number;
  accent: string;
  accent2: string;
  muted: string;
  text: string;
}) {
  const rows = args.bullets.slice(0, 3);
  if (!rows.length) return "";
  const cellW = args.w / rows.length;
  return `<g>${rows.map((item, i) => {
    const x = args.x + i * cellW;
    const color = i % 2 ? args.accent2 : args.accent;
    return `<circle cx="${x + 14}" cy="${args.y + 10}" r="5" fill="${color}"/>
      ${svgTextBlock({ text: item.text, x: x + 32, y: args.y + 18, widthChars: Math.max(18, Math.floor(cellW / 18)), maxLines: 2, size: 14, color: args.text })}`;
  }).join("")}</g>`;
}

export function renderDeckHtml(args: {
  blueprint: PptBlueprint;
  templateName: string;
  generatedAt: string;
}) {
  const theme = /huawei|华为/i.test(args.templateName || "") ? {
    accent: "#c7000b",
    accent2: "#0f766e",
  } : {
    accent: "#2563eb",
    accent2: "#0f766e",
  };
  const slides = args.blueprint.slides.map((slide, index) => {
    const title = splitTitle(slide.title);
    const refs = collectCitationRefs(slide);
    const kind = slideKind(slide, index, args.blueprint.slides.length);
    const displayLimit = displayLimitForKind(kind);
    const bullets = displayBullets(slide).slice(0, displayLimit);
    const visualRows = visualItems(slide).slice(0, displayLimit);
    const visual = kind === "process"
      ? `<div class="process">${bullets.map((item, i) => `<div class="step"><b>${i + 1}</b><span>${htmlEscape(item.text)}</span></div>`).join("")}</div>`
      : kind === "compare"
        ? `<div class="compare"><div>${bullets.filter((_, i) => i % 2 === 0).map((item) => `<p>${htmlEscape(item.text)}</p>`).join("")}</div><div>${bullets.filter((_, i) => i % 2 === 1).map((item) => `<p>${htmlEscape(item.text)}</p>`).join("")}</div></div>`
        : kind === "bar"
          ? `<div class="bars">${visualRows.map((row) => `<div><span>${htmlEscape(row.label)}</span><i style="width:${Math.max(16, numericValue(row.value, 3) * 22)}%"></i><em>${htmlEscape(row.value)}</em></div>`).join("")}</div>`
          : `<div class="cards">${visualRows.map((row) => `<section><b>${htmlEscape(row.label)}</b><strong>${htmlEscape(row.value)}</strong><p>${htmlEscape(row.note)}</p></section>`).join("")}</div>`;
    const visualFirst = ["kpi", "matrix", "timeline", "process", "bar"].includes(kind);
    const content = kind === "cover"
      ? `<main class="cover-main"><h1>${htmlEscape(title.main || args.blueprint.title)}</h1><p>${htmlEscape(args.blueprint.subtitle || slide.keyMessage || "")}</p><ul>${bullets.map((item) => `<li>${htmlEscape(item.text)}</li>`).join("")}</ul></main>`
      : visualFirst
        ? `<main class="main-visual"><div class="insight-strip">${bullets.slice(0, 3).map((item) => `<p>${htmlEscape(item.text)}</p>`).join("")}</div>${visual}</main>`
        : `<main><ul class="bullets">${bullets.map((item) => `<li>${htmlEscape(item.text)}</li>`).join("")}</ul>${visual}</main>`;
    return `<div class="slide-frame"><article class="slide ${kind}">
      <header>
        ${title.label ? `<span>${htmlEscape(title.label)}</span>` : ""}
        <h2>${htmlEscape(title.main)}</h2>
        ${slide.keyMessage ? `<p>${htmlEscape(slide.keyMessage)}</p>` : ""}
      </header>
      ${content}
      ${refs.length ? `<footer>${refs.map((ref) => htmlEscape(ref)).join(" · ")}</footer>` : `<footer>${index + 1}/${args.blueprint.slides.length}</footer>`}
    </article></div>`;
  }).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${htmlEscape(args.blueprint.title || "PPT Preview")}</title>
<style>
  :root { --accent:${theme.accent}; --accent2:${theme.accent2}; --text:#111827; --muted:#64748b; --line:#e5e7eb; --bg:#f8fafc; }
  * { box-sizing: border-box; }
  body { margin:0; background:#eef2f7; color:var(--text); font-family:"Microsoft YaHei","Noto Sans SC",Arial,sans-serif; }
  .deck { display:grid; gap:28px; padding:32px; justify-content:center; }
  .slide-frame { width:1280px; aspect-ratio:16/9; container-type:inline-size; overflow:hidden; }
  .slide { width:1280px; height:720px; background:white; border-radius:14px; box-shadow:0 18px 50px rgba(15,23,42,.12); padding:48px 58px; position:relative; overflow:hidden; }
  .slide::before { content:""; position:absolute; left:0; top:0; bottom:0; width:12px; background:var(--accent); }
  header { display:grid; grid-template-columns:auto 1fr; column-gap:18px; align-items:center; }
  header span { background:var(--accent); color:#fff; font-size:18px; font-weight:700; padding:7px 14px; border-radius:4px; }
  h2 { margin:0; font-size:30px; line-height:1.16; letter-spacing:0; }
  header p { grid-column:1 / -1; margin:14px 0 0; font-size:16px; color:var(--muted); }
  main { margin-top:30px; display:grid; grid-template-columns:.92fr 1.08fr; gap:28px; align-items:start; }
  .main-visual { grid-template-columns:1fr; gap:18px; }
  .bullets { margin:0; padding-left:22px; font-size:19px; line-height:1.55; }
  .bullets li::marker { color:var(--accent); }
  .insight-strip { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .insight-strip p { margin:0; border:1px solid var(--line); border-radius:8px; padding:12px 14px; color:var(--text); font-size:15px; line-height:1.35; background:#fff; }
  .cards { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .main-visual .cards { grid-template-columns:repeat(3,1fr); }
  .cards section, .compare div, .step { border:1px solid var(--line); border-radius:9px; background:#fff; padding:15px; min-height:92px; }
  .cards b { display:block; color:var(--accent); font-size:16px; margin-bottom:6px; }
  .cards strong { display:block; font-size:20px; margin-bottom:6px; }
  .cards p { margin:0; color:var(--muted); font-size:13px; line-height:1.42; }
  .compare { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .compare p { margin:0 0 14px; font-size:20px; line-height:1.45; }
  .process { grid-column:1 / -1; display:grid; grid-template-columns:repeat(4,1fr); gap:18px; }
  .step b { display:inline-grid; place-items:center; width:34px; height:34px; border-radius:999px; background:var(--accent); color:white; margin-bottom:18px; }
  .step span { display:block; font-size:20px; line-height:1.45; }
  .bars { display:grid; gap:20px; margin-top:10px; }
  .bars div { display:grid; grid-template-columns:140px 1fr 70px; gap:14px; align-items:center; font-size:18px; }
  .bars i { height:18px; border-radius:999px; background:linear-gradient(90deg,var(--accent),var(--accent2)); }
  .bars em { font-style:normal; color:var(--muted); text-align:right; }
  .cover-main { display:block; margin-top:118px; max-width:880px; }
  .cover-main h1 { font-size:44px; line-height:1.12; margin:0 0 20px; }
  .cover-main p { font-size:19px; color:var(--muted); margin:0 0 40px; }
  .cover-main ul { font-size:19px; line-height:1.55; }
  footer { position:absolute; left:58px; right:58px; bottom:30px; border-top:1px solid var(--line); padding-top:12px; color:var(--muted); font-size:13px; text-align:right; }
</style>
</head>
<body>
<div class="deck">
${slides}
</div>
</body>
</html>`;
}

function extractPptxText(outputAbs: string) {
  const entries = execFileSync("unzip", ["-Z1", outputAbs], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)?.[1] || 0) - Number(b.match(/slide(\d+)\.xml/)?.[1] || 0));
  return entries.map((entry, index) => {
    const xml = execFileSync("unzip", ["-p", outputAbs, entry], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const malformed = /(^|[^<])\/a:t>/.test(xml) || xml.includes("\uFFFD");
    const texts = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g))
      .map((match) => match[1] || "")
      .map((text) => text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'"))
      .map((text) => normalizeDeckText(text, 300))
      .filter(Boolean);
    return { pageNo: index + 1, entry, malformed, text: texts.join(" ") };
  });
}

export function buildQualityReport(args: {
  blueprint: PptBlueprint;
  pptxPath: string;
}) {
  const slideTexts = extractPptxText(args.pptxPath);
  const findings: Array<{ severity: "error" | "warning"; pageNo?: number; message: string }> = [];
  if (slideTexts.length !== args.blueprint.slides.length) {
    findings.push({ severity: "error", message: `slide count mismatch: expected ${args.blueprint.slides.length}, got ${slideTexts.length}` });
  }
  slideTexts.forEach((slide) => {
    if (slide.malformed) findings.push({ severity: "error", pageNo: slide.pageNo, message: "slide XML contains malformed text markers or replacement characters" });
  });
  args.blueprint.slides.forEach((slide, index) => {
    const actual = slideTexts[index]?.text || "";
    const title = splitTitle(slide.title).main || slide.title;
    if (title && !actual.includes(normalizeDeckText(title, 80))) {
      findings.push({ severity: "error", pageNo: index + 1, message: `missing title: ${title}` });
    }
    const kind = slideKind(slide, index, args.blueprint.slides.length);
    const displayLimit = displayLimitForKind(kind);
    const visualRows = visualItems(slide).slice(0, displayLimit);
    const expectedRows = (
      visualRows.length && ["bar", "kpi", "matrix", "summary", "timeline"].includes(kind)
        ? visualRows.map(row => row.value || row.label || row.note).filter(Boolean)
        : displayBullets(slide).slice(0, displayLimit).map(item => item.text)
    );
    expectedRows.forEach((item) => {
      const expected = normalizeDeckText(item, 38);
      if (expected && !actual.includes(expected)) {
        findings.push({ severity: "warning", pageNo: index + 1, message: `bullet may be missing or heavily truncated: ${expected}` });
      }
    });
  });
  const ok = !findings.some((item) => item.severity === "error");
  return {
    ok,
    generatedAt: new Date().toISOString(),
    slideCount: slideTexts.length,
    expectedSlideCount: args.blueprint.slides.length,
    findings,
  };
}

function renderSlideSvg(args: {
  slide: PptBlueprintSlide;
  index: number;
  total: number;
  templateName: string;
  theme?: DeckTheme;
  deckTitle?: string;
  deckSubtitle?: string;
}) {
  const resolvedTheme = args.theme || resolveDeckTheme(args.templateName);
  const accent = resolvedTheme.accent;
  const accent2 = resolvedTheme.accent2;
  const text = resolvedTheme.text;
  const muted = resolvedTheme.muted;
  const border = resolvedTheme.border;
  const bg = args.index === 0 ? "#ffffff" : "#f8fafc";
  const fontFamily = `"WenQuanYi Zen Hei","Noto Sans SC","Microsoft YaHei",Arial,sans-serif`;
  const kind = slideKind(args.slide, args.index, args.total);
  const title = splitTitle(args.slide.title || args.deckTitle || "PPT 制作");
  const displayLimit = displayLimitForKind(kind);
  const bullets = displayBullets(args.slide).slice(0, displayLimit);
  const refs = collectCitationRefs(args.slide);
  const visualRows = visualItems(args.slide).slice(0, displayLimit);
  const header = kind === "cover" ? "" : `
    ${title.label ? `<rect x="74" y="45" width="116" height="34" rx="4" fill="${accent}"/><text x="132" y="68" text-anchor="middle" font-size="18" font-weight="700" fill="#fff">${svgEscape(title.label)}</text>` : ""}
    ${svgTextBlock({ text: title.main, x: title.label ? 210 : 74, y: 72, widthChars: title.label ? 42 : 54, maxLines: 1, size: 34, weight: 700, color: text })}
    ${args.slide.keyMessage ? svgTextBlock({ text: args.slide.keyMessage, x: 78, y: 126, widthChars: 70, maxLines: 2, size: 18, color: muted }) : ""}`;

  const footer = `
    <line x1="58" y1="675" x2="1222" y2="675" stroke="${border}" stroke-width="1"/>
    ${refs.length
      ? svgTextBlock({ text: `来源：${refs.join(" · ")}`, x: 72, y: 702, widthChars: 94, maxLines: 1, size: 12, color: muted })
      : `<text x="1180" y="702" text-anchor="end" font-size="14" fill="${muted}">${args.index + 1}/${args.total}</text>`}
    <rect x="58" y="690" width="28" height="5" rx="2" fill="${accent}"/>`;

  let body = "";
  if (kind === "cover") {
    body = `
      <rect x="0" y="0" width="16" height="720" fill="${accent}"/>
      <rect x="72" y="74" width="108" height="8" rx="4" fill="${accent}"/>
      ${svgTextBlock({ text: title.label || "汇报材料", x: 72, y: 154, widthChars: 14, maxLines: 1, size: 24, weight: 700, color: accent })}
      ${svgTextBlock({ text: title.main || args.deckTitle, x: 72, y: 250, widthChars: 30, maxLines: 2, size: 52, weight: 700, color: text, lineHeight: 64 })}
      ${svgTextBlock({ text: args.deckSubtitle || args.slide.keyMessage || "", x: 76, y: 326, widthChars: 54, maxLines: 2, size: 22, color: muted })}
      ${bullets.slice(0, 4).map((item, i) => `<circle cx="92" cy="${438 + i * 42}" r="5" fill="${accent}"/>${svgTextBlock({ text: item.text, x: 112, y: 446 + i * 42, widthChars: 46, maxLines: 1, size: 21, color: text })}`).join("")}
      <rect x="930" y="438" width="250" height="126" rx="14" fill="#f1f5f9" stroke="${border}"/>
      <text x="1055" y="494" text-anchor="middle" font-size="20" fill="${muted}">AI 生成初稿</text>
      <text x="1055" y="530" text-anchor="middle" font-size="18" fill="${muted}">请人工复核数据与表述</text>`;
  } else if (kind === "agenda") {
    const rows = bullets.length ? bullets : args.total > 1
      ? args.slide.bullets.slice(0, 4)
      : [];
    body = (rows.length ? rows : visualRows.map((row) => ({ text: `${row.label}：${row.value || row.note}` }))).slice(0, 6).map((item: any, i) => {
      const y = 210 + i * 66;
      const color = i % 2 ? accent2 : accent;
      return `<circle cx="112" cy="${y}" r="20" fill="${color}"/>
        <text x="112" y="${y + 7}" text-anchor="middle" font-size="18" font-weight="700" fill="#fff">${String(i + 1).padStart(2, "0")}</text>
        <rect x="154" y="${y - 28}" width="890" height="56" rx="14" fill="#fff" stroke="${border}"/>
        ${svgTextBlock({ text: item.text || item.label || "", x: 184, y: y + 7, widthChars: 52, maxLines: 1, size: 22, color: text })}
        <line x1="112" y1="${y + 24}" x2="112" y2="${y + 58}" stroke="${border}" stroke-width="2" ${i === rows.length - 1 ? 'opacity="0"' : ""}/>`;
    }).join("");
  } else if (kind === "kpi") {
    const rows = visualRows.length ? visualRows : bullets.slice(0, displayLimit).map((item, index) => ({ label: `指标 ${index + 1}`, value: item.text, note: "" }));
    body = rows.slice(0, displayLimit).map((row, i) => {
      const x = 82 + (i % 3) * 370;
      const y = 200 + Math.floor(i / 3) * 178;
      const color = i % 2 ? accent2 : accent;
      return `<rect x="${x}" y="${y}" width="320" height="132" rx="16" fill="#fff" stroke="${border}"/>
        <rect x="${x}" y="${y}" width="8" height="132" rx="4" fill="${color}"/>
        ${svgTextBlock({ text: row.value || row.label, x: x + 28, y: y + 52, widthChars: 13, maxLines: 1, size: 30, weight: 700, color })}
        ${svgTextBlock({ text: row.label, x: x + 28, y: y + 88, widthChars: 15, maxLines: 1, size: 17, weight: 700, color: text })}
        ${svgTextBlock({ text: row.note, x: x + 28, y: y + 116, widthChars: 18, maxLines: 1, size: 13, color: muted })}`;
    }).join("");
  } else if (kind === "timeline") {
    const rows = visualRows.length ? visualRows : bullets.slice(0, displayLimit).map((item, index) => ({ label: `阶段 ${index + 1}`, value: item.text, note: "" }));
    const timelineRows = rows.slice(0, displayLimit);
    body = `<line x1="128" y1="334" x2="1130" y2="334" stroke="${border}" stroke-width="4"/>` + timelineRows.map((row, i) => {
      const x = rows.length > 1 ? 128 + i * (1002 / Math.max(1, rows.slice(0, displayLimit).length - 1)) : 620;
      const up = i % 2 === 0;
      const boxY = up ? 176 : 382;
      const color = i % 2 ? accent2 : accent;
      return `<circle cx="${x}" cy="334" r="16" fill="${color}" stroke="#fff" stroke-width="5"/>
        <line x1="${x}" y1="${up ? 222 : 350}" x2="${x}" y2="${up ? 318 : 382}" stroke="${border}" stroke-width="2"/>
        <rect x="${x - 104}" y="${boxY}" width="208" height="112" rx="12" fill="#fff" stroke="${border}"/>
        ${svgTextBlock({ text: row.label, x: x - 82, y: boxY + 30, widthChars: 12, maxLines: 1, size: 16, weight: 700, color })}
        ${svgTextBlock({ text: row.value || row.note, x: x - 82, y: boxY + 58, widthChars: 12, maxLines: 1, size: 14, color: text })}
        ${svgTextBlock({ text: row.note, x: x - 82, y: boxY + 88, widthChars: 15, maxLines: 1, size: 12, color: muted })}`;
    }).join("") + `<g>${supportingInsightRows(args.slide, bullets, 3).map((item, i) => {
      const x = 120 + i * 365;
      return `<circle cx="${x}" cy="590" r="5" fill="${i % 2 ? accent2 : accent}"/>${svgTextBlock({ text: item.text, x: x + 18, y: 598, widthChars: 22, maxLines: 2, size: 15, color: text })}`;
    }).join("")}</g>`;
  } else if (kind === "matrix") {
    const rows = visualRows.length ? visualRows : bullets.slice(0, 4).map((item, index) => ({ label: `象限 ${index + 1}`, value: item.text, note: "" }));
    body = rows.concat([
      { label: "重点突破", value: "", note: "" },
      { label: "持续优化", value: "", note: "" },
      { label: "观察验证", value: "", note: "" },
      { label: "暂缓投入", value: "", note: "" },
    ]).slice(0, 4).map((row, i) => {
      const x = 120 + (i % 2) * 500;
      const y = 170 + Math.floor(i / 2) * 128;
      const color = i === 0 ? accent : i === 1 ? accent2 : muted;
      return `<rect x="${x}" y="${y}" width="430" height="100" rx="16" fill="#fff" stroke="${border}"/>
        ${svgTextBlock({ text: row.label, x: x + 24, y: y + 36, widthChars: 20, maxLines: 1, size: 21, weight: 700, color })}
        ${svgTextBlock({ text: row.value || row.note, x: x + 24, y: y + 67, widthChars: 24, maxLines: 1, size: 15, color: text })}
        ${row.note && row.value ? svgTextBlock({ text: row.note, x: x + 24, y: y + 91, widthChars: 25, maxLines: 1, size: 12, color: muted }) : ""}`;
    }).join("") + renderInsightStrip({ bullets: supportingInsightRows(args.slide, bullets, 3), x: 116, y: 458, w: 1010, accent, accent2, muted, text })
      + renderConceptIllustration({ slide: args.slide, x: 92, y: 548, w: 1060, h: 92, accent, accent2, border, muted, text });
  } else if (kind === "process") {
    body = bullets.slice(0, 4).map((item, i) => {
      const x = 72 + i * 300;
      return `<rect x="${x}" y="270" width="262" height="162" rx="14" fill="#fff" stroke="${i % 2 ? accent2 : accent}" stroke-width="2"/>
        <circle cx="${x + 38}" cy="308" r="20" fill="${i % 2 ? accent2 : accent}"/>
        <text x="${x + 38}" y="316" text-anchor="middle" font-size="20" font-weight="700" fill="#fff">${i + 1}</text>
        ${svgTextBlock({ text: item.text, x: x + 28, y: 365, widthChars: 11, maxLines: 4, size: 19, color: text })}
        ${i < 3 ? `<text x="${x + 262}" y="352" font-size="32" fill="${muted}">→</text>` : ""}`;
    }).join("");
  } else if (kind === "compare") {
    const left = bullets.filter((_, i) => i % 2 === 0);
    const right = bullets.filter((_, i) => i % 2 === 1);
    body = [left, right].map((items, col) => {
      const x = col ? 684 : 74;
      const color = col ? accent2 : accent;
      return `<rect x="${x}" y="178" width="540" height="430" rx="14" fill="#fff" stroke="${border}"/>
        <text x="${x + 30}" y="228" font-size="26" font-weight="700" fill="${color}">${col ? "目标 / 建议" : "现状 / 依据"}</text>
        ${items.slice(0, 4).map((item, i) => `<circle cx="${x + 36}" cy="${286 + i * 72}" r="5" fill="${color}"/>${svgTextBlock({ text: item.text, x: x + 54, y: 294 + i * 72, widthChars: 24, maxLines: 2, size: 20, color: text })}`).join("")}`;
    }).join("");
  } else if (kind === "bar") {
    body = visualRows.slice(0, 5).map((row, i) => {
      const y = 188 + i * 48;
      const width = Math.max(90, Math.min(500, numericValue(row.value, visualRows.length - i) * 78));
      return `${svgTextBlock({ text: row.label, x: 96, y: y + 18, widthChars: 12, maxLines: 1, size: 18, color: text })}
        <rect x="300" y="${y}" width="520" height="20" rx="10" fill="#e2e8f0"/>
        <rect x="300" y="${y}" width="${width}" height="22" rx="11" fill="${i % 2 ? accent2 : accent}"/>
        ${svgTextBlock({ text: row.value, x: 842, y: y + 18, widthChars: 8, maxLines: 1, size: 16, color: muted })}
        ${row.note ? svgTextBlock({ text: row.note, x: 940, y: y + 18, widthChars: 14, maxLines: 1, size: 12, color: muted }) : ""}`;
    }).join("") + renderInsightStrip({ bullets: supportingInsightRows(args.slide, bullets, 3), x: 116, y: 470, w: 1010, accent, accent2, muted, text })
      + renderConceptIllustration({ slide: args.slide, x: 92, y: 548, w: 1060, h: 92, accent, accent2, border, muted, text });
  } else if (kind === "summary") {
    const summaryRows = visualRows.length
      ? visualRows.slice(0, displayLimit).map((row) => ({
        label: row.label,
        value: row.value,
        note: row.note,
        text: `${row.label}${row.value ? `：${row.value}` : ""}`,
      }))
      : bullets.slice(0, displayLimit).map((item) => ({ label: "", value: item.text, note: "", text: item.text }));
    const summaryCols = summaryRows.length <= 4 ? 2 : 3;
    const cardW = summaryCols === 2 ? 500 : 335;
    const cardH = summaryCols === 2 ? 112 : 92;
    const startX = summaryCols === 2 ? 120 : 86;
    const gapX = summaryCols === 2 ? 560 : 382;
    const startY = summaryCols === 2 ? 198 : 188;
    const gapY = summaryCols === 2 ? 154 : 128;
    body = summaryRows.map((item, i) => {
      const x = startX + (i % summaryCols) * gapX;
      const y = startY + Math.floor(i / summaryCols) * gapY;
      const color = i % 2 ? accent2 : accent;
      return `<rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="14" fill="#fff" stroke="${border}"/>
        <rect x="${x}" y="${y}" width="7" height="${cardH}" rx="4" fill="${color}"/>
        ${item.label ? svgTextBlock({ text: item.label, x: x + 26, y: y + 30, widthChars: 8, maxLines: 1, size: 18, weight: 700, color }) : ""}
        ${svgTextBlock({ text: item.value || item.text, x: x + 26, y: y + 58, widthChars: summaryCols === 2 ? 26 : 18, maxLines: 1, size: 15, weight: 700, color: text })}
        ${item.note ? svgTextBlock({ text: item.note, x: x + 26, y: y + 84, widthChars: summaryCols === 2 ? 30 : 20, maxLines: 1, size: 12, color: muted }) : ""}`;
    }).join("") + renderConceptIllustration({ slide: args.slide, x: 92, y: 500, w: 1060, h: 120, accent, accent2, border, muted, text });
  } else if (kind === "table") {
    const rows = (visualRows.length
      ? visualRows.slice(0, displayLimit).map((row) => ({
        label: row.label,
        text: `${row.value || row.label}${row.note ? `: ${row.note}` : ""}`,
      }))
      : bullets.slice(0, displayLimit));
    body = `<rect x="92" y="176" width="1060" height="${58 + rows.length * 52}" rx="14" fill="#fff" stroke="${border}"/>
      <rect x="92" y="176" width="1060" height="50" rx="14" fill="#f1f5f9"/>
      <text x="130" y="222" font-size="18" font-weight="700" fill="${muted}">维度</text>
      <text x="265" y="222" font-size="18" font-weight="700" fill="${muted}">要点</text>
      ${rows.map((item, i) => {
        const y = 258 + i * 52;
        return `<line x1="92" y1="${y - 25}" x2="1152" y2="${y - 25}" stroke="${border}"/>
          <text x="132" y="${y}" font-size="16" font-weight="700" fill="${i % 2 ? accent2 : accent}">${svgEscape((item as any).label || String(i + 1))}</text>
          ${svgTextBlock({ text: item.text, x: 265, y, widthChars: 62, maxLines: 1, size: 16, color: text })}`;
      }).join("")}
      ${renderInsightStrip({ bullets: supportingInsightRows(args.slide, bullets, 3), x: 116, y: 570, w: 1010, accent, accent2, muted, text })}
      ${renderConceptIllustration({ slide: args.slide, x: 92, y: 548, w: 1060, h: 92, accent, accent2, border, muted, text })}`;
  } else {
    const cards = visualRows.length ? visualRows.slice(0, displayLimit) : bullets.slice(0, displayLimit).map((item, index) => ({ label: `要点 ${index + 1}`, value: "", note: item.text }));
    body = `
      <g>${bullets.slice(0, displayLimit).map((item, i) => `<circle cx="98" cy="${205 + i * 48}" r="5" fill="${i % 2 ? accent2 : accent}"/>${svgTextBlock({ text: item.text, x: 118, y: 213 + i * 48, widthChars: 32, maxLines: 1, size: 18, color: text })}`).join("")}</g>
      <g>${cards.map((row, i) => {
        const x = 700 + (i % 2) * 250;
        const y = 185 + Math.floor(i / 2) * 112;
        return `<rect x="${x}" y="${y}" width="220" height="92" rx="12" fill="#fff" stroke="${border}"/>
          ${svgTextBlock({ text: row.label, x: x + 16, y: y + 30, widthChars: 12, maxLines: 1, size: 15, weight: 700, color: i % 2 ? accent2 : accent })}
          ${row.value ? svgTextBlock({ text: row.value, x: x + 16, y: y + 56, widthChars: 12, maxLines: 1, size: 15, weight: 700, color: text }) : ""}
          ${svgTextBlock({ text: row.note, x: x + 16, y: y + 78, widthChars: 15, maxLines: 1, size: 12, color: muted })}`;
      }).join("")}</g>
      ${renderInsightStrip({ bullets: supportingInsightRows(args.slide, bullets, 3), x: 116, y: 570, w: 1010, accent, accent2, muted, text })}
      ${renderConceptIllustration({ slide: args.slide, x: 92, y: 515, w: 1060, h: 118, accent, accent2, border, muted, text })}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="${bg}"/>
    <style>text{font-family:${fontFamily};dominant-baseline:alphabetic}</style>
    ${header}
    ${body}
    ${footer}
  </svg>`;
}

export async function generateImagePptxFromBlueprint(args: {
  blueprint: PptBlueprint;
  outputAbs: string;
  imageDirAbs: string;
  templateName: string;
  templateAbs?: string;
}) {
  rmSync(args.imageDirAbs, { recursive: true, force: true });
  mkdirSync(args.imageDirAbs, { recursive: true });
  const PptxGen = ((pptxgenjs as any).default || pptxgenjs) as any;
  const pptx = new PptxGen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Workforce Agent Platform";
  pptx.company = "Workforce Agent Platform";
  pptx.subject = args.blueprint.title || "PPT 制作";
  pptx.title = `${args.blueprint.title || "PPT 制作"} - 高保真版`;
  const slides = args.blueprint.slides.slice(0, 20);
  const theme = resolveDeckTheme(args.templateName, args.templateAbs);
  for (let i = 0; i < slides.length; i += 1) {
    const svg = renderSlideSvg({
      slide: slides[i],
      index: i,
      total: slides.length,
      templateName: args.templateName,
      theme,
      deckTitle: args.blueprint.title,
      deckSubtitle: args.blueprint.subtitle,
    });
    const pngAbs = path.join(args.imageDirAbs, `slide-${String(i + 1).padStart(2, "0")}.png`);
    await sharp(Buffer.from(svg)).png().resize(1600, 900, { fit: "fill" }).toFile(pngAbs);
    const slide: any = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addImage({ path: pngAbs, x: 0, y: 0, w: WIDE_SLIDE.w, h: WIDE_SLIDE.h });
  }
  await pptx.writeFile({ fileName: args.outputAbs, compression: true });
}

export async function generatePptxFromBlueprint(args: {
  blueprint: PptBlueprint;
  outputAbs: string;
  templateName: string;
  templatePath: string;
  instruction: string;
}) {
  const PptxGen = ((pptxgenjs as any).default || pptxgenjs) as any;
  const pptx = new PptxGen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Workforce Agent Platform";
  pptx.company = "Workforce Agent Platform";
  pptx.subject = args.instruction || args.blueprint.title || "PPT 制作";
  pptx.title = args.blueprint.title || "PPT 制作";
  pptx.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei",
  };

  const theme = {
    bg: "F8FAFC",
    panel: "FFFFFF",
    text: "111827",
    muted: "64748B",
    accent: /huawei/i.test(args.templatePath) || /huawei|华为/i.test(args.templateName) ? "C7000B" : "2563EB",
    accent2: "0F766E",
    pale: "F1F5F9",
    border: "E5E7EB",
  };
  const slides = args.blueprint.slides.slice(0, 20);
  const total = slides.length;

  slides.forEach((item, index) => {
    const kind = slideKind(item, index, total);
    const slide: any = pptx.addSlide();
    slide.background = { color: kind === "cover" ? theme.panel : theme.bg };

    if (kind === "cover") {
      slide.addShape("rect", { x: 0, y: 0, w: 0.16, h: WIDE_SLIDE.h, fill: { color: theme.accent }, line: { color: theme.accent } });
      slide.addShape("rect", { x: 0.6, y: 0.72, w: 1.0, h: 0.08, fill: { color: theme.accent }, line: { color: theme.accent } });
      const title = splitTitle(item.title || args.blueprint.title || "PPT 制作");
      slide.addText(title.label || "汇报材料", { x: 0.72, y: 1.25, w: 2.2, h: 0.36, fontFace: "Microsoft YaHei", fontSize: 11.5, bold: true, color: theme.accent });
      slide.addText(title.main || args.blueprint.title || "PPT 制作", { x: 0.72, y: 1.7, w: 10.8, h: 0.95, fontFace: "Microsoft YaHei", fontSize: 29, bold: true, color: theme.text, fit: "shrink" });
      slide.addText(args.blueprint.subtitle || item.keyMessage || "由灵感岗位智能体生成", { x: 0.75, y: 2.82, w: 9.8, h: 0.36, fontFace: "Microsoft YaHei", fontSize: 11.5, color: theme.muted, fit: "shrink" });
      if (item.bullets.length) {
        slide.addText(bulletText(item), { x: 0.78, y: 4.2, w: 8.5, h: 1.25, fontFace: "Microsoft YaHei", fontSize: 12.2, color: theme.text, breakLine: false, fit: "shrink" });
      }
      slide.addShape("rect", { x: 9.4, y: 4.2, w: 2.8, h: 1.5, rectRadius: 0.08, fill: { color: theme.pale }, line: { color: theme.border } });
      slide.addText("AI 生成初稿\n请人工复核数据与表述", { x: 9.65, y: 4.55, w: 2.3, h: 0.7, fontFace: "Microsoft YaHei", fontSize: 11, color: theme.muted, align: "center", valign: "mid" });
      addCitationFooter(slide, item, theme);
      addFooter(slide, index + 1, total, theme);
      return;
    }

    addSlideTitle(slide, item, theme);
    const y0 = item.keyMessage ? 1.48 : 1.28;
    const displayLimit = displayLimitForKind(kind);

    if (kind === "agenda") {
      const rows = item.bullets.length ? displayBullets(item) : slides.slice(1).map((s) => ({ text: s.title }));
      rows.slice(0, 8).forEach((row, i) => {
        const y = y0 + i * 0.58;
        slide.addShape("ellipse", { x: 1.0, y, w: 0.32, h: 0.32, fill: { color: theme.accent }, line: { color: theme.accent } });
        slide.addText(String(i + 1).padStart(2, "0"), { x: 1.43, y: y - 0.02, w: 0.55, h: 0.26, fontFace: "Aptos", fontSize: 9, bold: true, color: theme.accent });
        slide.addText(compactText(row.text, 64), { x: 2.05, y: y - 0.04, w: 9.5, h: 0.34, fontFace: "Microsoft YaHei", fontSize: 13, color: theme.text, fit: "shrink" });
      });
    } else if (kind === "kpi") {
      const rows = visualItems(item, item.title).slice(0, displayLimit);
      rows.forEach((row, i) => {
        const col = i % 3;
        const r = Math.floor(i / 3);
        const x = 0.82 + col * 4.0;
        const y = y0 + r * 1.72;
        slide.addShape("rect", { x, y, w: 3.55, h: 1.28, rectRadius: 0.08, fill: { color: theme.panel }, line: { color: theme.border } });
        slide.addShape("rect", { x, y, w: 0.08, h: 1.28, fill: { color: i % 2 ? theme.accent2 : theme.accent }, line: { color: i % 2 ? theme.accent2 : theme.accent } });
        slide.addText(row.value || String(i + 1).padStart(2, "0"), { x: x + 0.28, y: y + 0.18, w: 1.6, h: 0.32, fontFace: "Aptos", fontSize: 16, bold: true, color: i % 2 ? theme.accent2 : theme.accent, fit: "shrink" });
        slide.addText(row.label, { x: x + 0.3, y: y + 0.58, w: 2.85, h: 0.24, fontFace: "Microsoft YaHei", fontSize: 9.5, bold: true, color: theme.text, fit: "shrink" });
        slide.addText(row.note, { x: x + 0.3, y: y + 0.88, w: 2.88, h: 0.24, fontFace: "Microsoft YaHei", fontSize: 7.8, color: theme.muted, fit: "shrink" });
      });
    } else if (kind === "timeline") {
      const rows = visualItems(item, item.title).slice(0, displayLimit);
      const baseY = y0 + 1.8;
      slide.addShape("line", { x: 1.0, y: baseY, w: 11.1, h: 0, line: { color: theme.border, width: 2 } });
      rows.forEach((row, i) => {
        const step = rows.length > 1 ? 10.6 / (rows.length - 1) : 0;
        const x = 0.95 + i * step;
        const up = i % 2 === 0;
        slide.addShape("ellipse", { x, y: baseY - 0.15, w: 0.3, h: 0.3, fill: { color: i % 2 ? theme.accent2 : theme.accent }, line: { color: "FFFFFF", width: 1 } });
        slide.addShape("line", { x: x + 0.15, y: up ? baseY - 1.05 : baseY + 0.18, w: 0, h: 0.86, line: { color: theme.border, width: 1 } });
        slide.addShape("rect", { x: Math.max(0.62, x - 0.62), y: up ? baseY - 1.65 : baseY + 0.78, w: 1.55, h: 0.78, rectRadius: 0.05, fill: { color: theme.panel }, line: { color: theme.border } });
        slide.addText(row.value || row.label, { x: Math.max(0.72, x - 0.52), y: up ? baseY - 1.5 : baseY + 0.92, w: 1.32, h: 0.2, fontFace: "Microsoft YaHei", fontSize: 8.5, bold: true, color: i % 2 ? theme.accent2 : theme.accent, align: "center", fit: "shrink" });
        slide.addText(row.note || row.label, { x: Math.max(0.72, x - 0.52), y: up ? baseY - 1.24 : baseY + 1.18, w: 1.32, h: 0.28, fontFace: "Microsoft YaHei", fontSize: 7.5, color: theme.text, align: "center", fit: "shrink" });
      });
    } else if (kind === "matrix") {
      const rows = visualItems(item, item.title).slice(0, 4);
      const labels = ["重点突破", "持续优化", "观察验证", "暂缓投入"];
      rows.concat(labels.slice(rows.length).map((label) => ({ label, value: "", note: "" }))).slice(0, 4).forEach((row, i) => {
        const col = i % 2;
        const r = Math.floor(i / 2);
        const x = 1.02 + col * 5.55;
        const y = y0 + r * 2.0;
        const color = i === 0 ? theme.accent : i === 1 ? theme.accent2 : theme.muted;
        slide.addShape("rect", { x, y, w: 5.15, h: 1.55, rectRadius: 0.06, fill: { color: theme.panel }, line: { color: theme.border } });
        slide.addText(row.label, { x: x + 0.28, y: y + 0.24, w: 4.4, h: 0.28, fontFace: "Microsoft YaHei", fontSize: 13, bold: true, color, fit: "shrink" });
        slide.addText(row.value || row.note, { x: x + 0.28, y: y + 0.66, w: 4.45, h: 0.42, fontFace: "Microsoft YaHei", fontSize: 10, color: theme.text, fit: "shrink" });
      });
      slide.addText("高影响", { x: 0.8, y: y0 - 0.25, w: 1.0, h: 0.18, fontSize: 8, color: theme.muted });
      slide.addText("低确定性", { x: 0.18, y: y0 + 3.4, w: 0.8, h: 0.18, rotate: 270, fontSize: 8, color: theme.muted });
    } else if (kind === "bar") {
      const rows = visualItems(item, item.title).slice(0, displayLimit);
      const values = rows.map((row, i) => Math.max(0, numericValue(row.value, rows.length - i)));
      const max = Math.max(...values, 1);
      rows.forEach((row, i) => {
        const y = y0 + 0.35 + i * 0.62;
        const width = 7.4 * (values[i] / max);
        slide.addText(row.label, { x: 0.9, y: y - 0.02, w: 2.5, h: 0.22, fontFace: "Microsoft YaHei", fontSize: 9.5, color: theme.text, fit: "shrink" });
        slide.addShape("rect", { x: 3.65, y, w: 7.55, h: 0.22, rectRadius: 0.03, fill: { color: "E2E8F0" }, line: { color: "E2E8F0" } });
        slide.addShape("rect", { x: 3.65, y, w: Math.max(0.12, width), h: 0.22, rectRadius: 0.03, fill: { color: i % 2 ? theme.accent2 : theme.accent }, line: { color: i % 2 ? theme.accent2 : theme.accent } });
        slide.addText(row.value || String(values[i]), { x: 11.35, y: y - 0.03, w: 0.85, h: 0.2, fontFace: "Aptos", fontSize: 8.5, bold: true, color: theme.muted, align: "right" });
      });
    } else if (kind === "compare") {
      const rows = displayBullets(item, item.title).slice(0, displayLimit);
      const left = rows.filter((_, i) => i % 2 === 0);
      const right = rows.filter((_, i) => i % 2 === 1);
      [
        { x: 0.85, title: "现状 / 依据", data: left.length ? left : rows.slice(0, 3), color: theme.accent },
        { x: 6.95, title: "目标 / 建议", data: right.length ? right : rows.slice(3), color: theme.accent2 },
      ].forEach((col) => {
        slide.addShape("rect", { x: col.x, y: y0, w: 5.55, h: 4.75, rectRadius: 0.06, fill: { color: theme.panel }, line: { color: theme.border } });
        slide.addText(col.title, { x: col.x + 0.28, y: y0 + 0.25, w: 4.8, h: 0.35, fontFace: "Microsoft YaHei", fontSize: 12.5, bold: true, color: col.color });
        slide.addText(col.data.slice(0, 4).map((r) => `• ${compactText(r.text, 64)}`).join("\n"), { x: col.x + 0.35, y: y0 + 0.88, w: 4.85, h: 3.2, fontFace: "Microsoft YaHei", fontSize: 10.5, color: theme.text, breakLine: false, fit: "shrink" });
      });
    } else if (kind === "process") {
      const rows = displayBullets(item, item.title).slice(0, displayLimit);
      rows.forEach((row, i) => {
        const w = 10.8 / rows.length;
        const x = 0.95 + i * w;
        slide.addShape("rect", { x, y: y0 + 1.2, w: w - 0.18, h: 1.3, rectRadius: 0.08, fill: { color: theme.panel }, line: { color: i % 2 ? theme.accent2 : theme.accent, width: 1.1 } });
        slide.addText(String(i + 1), { x: x + 0.2, y: y0 + 1.38, w: 0.35, h: 0.3, fontFace: "Aptos", fontSize: 13, bold: true, color: i % 2 ? theme.accent2 : theme.accent });
        slide.addText(compactText(row.text, 46), { x: x + 0.2, y: y0 + 1.82, w: w - 0.55, h: 0.42, fontFace: "Microsoft YaHei", fontSize: 9.8, color: theme.text, fit: "shrink" });
        if (i < rows.length - 1) slide.addText("→", { x: x + w - 0.12, y: y0 + 1.68, w: 0.25, h: 0.2, fontSize: 14, color: theme.muted });
      });
    } else if (kind === "table") {
      const rows = displayBullets(item, item.title).slice(0, displayLimit);
      const rowH = 0.58;
      const tableY = y0 + 0.12;
      slide.addShape("rect", { x: 0.85, y: tableY, w: 11.7, h: rowH * (rows.length + 1), rectRadius: 0.06, fill: { color: theme.panel }, line: { color: theme.border } });
      slide.addShape("rect", { x: 0.85, y: tableY, w: 11.7, h: rowH, rectRadius: 0.06, fill: { color: theme.pale }, line: { color: theme.border } });
      slide.addText("维度", { x: 1.12, y: tableY + 0.17, w: 1.2, h: 0.2, fontFace: "Microsoft YaHei", fontSize: 10, bold: true, color: theme.muted });
      slide.addText("要点", { x: 2.55, y: tableY + 0.17, w: 8.8, h: 0.2, fontFace: "Microsoft YaHei", fontSize: 10, bold: true, color: theme.muted });
      rows.forEach((row, i) => {
        const y = tableY + rowH * (i + 1);
        slide.addShape("line", { x: 0.85, y, w: 11.7, h: 0, line: { color: theme.border, width: 0.6 } });
        slide.addText(String(i + 1), { x: 1.12, y: y + 0.18, w: 0.5, h: 0.18, fontFace: "Aptos", fontSize: 9, bold: true, color: i % 2 ? theme.accent2 : theme.accent });
        slide.addText(compactText(row.text, 80), { x: 2.55, y: y + 0.14, w: 8.9, h: 0.26, fontFace: "Microsoft YaHei", fontSize: 9.3, color: theme.text, fit: "shrink" });
      });
    } else {
      const rows = displayBullets(item, item.title).slice(0, displayLimit);
      rows.forEach((row, i) => {
        const col = i % 2;
        const r = Math.floor(i / 2);
        const x = 0.85 + col * 5.95;
        const y = y0 + r * 1.28;
        slide.addShape("rect", { x, y, w: 5.55, h: 0.96, rectRadius: 0.06, fill: { color: theme.panel }, line: { color: theme.border } });
        slide.addShape("rect", { x, y, w: 0.08, h: 0.96, fill: { color: i % 2 ? theme.accent2 : theme.accent }, line: { color: i % 2 ? theme.accent2 : theme.accent } });
        slide.addText(compactText(row.text, 76), { x: x + 0.28, y: y + 0.17, w: 4.95, h: 0.5, fontFace: "Microsoft YaHei", fontSize: 10.5, color: theme.text, fit: "shrink" });
      });
    }

    addCitationFooter(slide, item, theme);
    addFooter(slide, index + 1, total, theme);
  });

  await pptx.writeFile({ fileName: args.outputAbs, compression: true });
}

function buildResultSummary(args: {
  blueprint: PptBlueprint;
  templateName: string;
  templatePath: string;
  resultPath: string;
  editableResultPath?: string;
  resultNotePath: string;
  htmlPreviewPath?: string;
  qualityReportPath?: string;
  qualityOk?: boolean;
}) {
  const titles = args.blueprint.slides.map((slide, index) => `${index + 1}. ${slide.title}`).join("\n");
  return [
    "# PPT 生成说明",
    "",
    `- 生成页数：${args.blueprint.slides.length}`,
    `- 使用模板：${args.templateName}`,
    `- 模板文件：${args.templatePath}`,
    `- 输出文件：${args.resultPath}`,
    args.editableResultPath ? `- 可编辑版本：${args.editableResultPath}` : "",
    `- 说明文件：${args.resultNotePath}`,
    args.htmlPreviewPath ? `- HTML 预览：${args.htmlPreviewPath}` : "",
    args.qualityReportPath ? `- 质量报告：${args.qualityReportPath}` : "",
    typeof args.qualityOk === "boolean" ? `- 质量校验：${args.qualityOk ? "通过" : "需关注"}` : "",
    "",
    "## 生成方式",
    "",
    "OpenClaw 负责生成可审核的 PPT 大纲和 PPT_BLUEPRINT_JSON；employee-agent 使用固定商务版式生成 PPTX。",
    "",
    "## 页面清单",
    "",
    titles,
    "",
    "## 当前限制",
    "",
    "- 第一版优先保证结构、标题、要点和可下载文件稳定。",
    "- 本版已增加 HTML 预览和 PPTX 结构校验；复杂图表和母版精确复刻会继续迭代。",
  ].join("\n");
}

export function registerOfficePptRoutes(app: express.Express) {
  app.get("/api/claw/office/ppt-create/templates/:id/thumbnail", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const template = BUILTIN_TEMPLATES.find((item) => item.id === id);
    if (!template || !existsSync(template.thumbnailPath)) return res.status(404).end();
    res.sendFile(template.thumbnailPath);
  });

  app.get("/api/claw/office/ppt-create/templates", async (_req, res) => {
    res.json({
      templates: BUILTIN_TEMPLATES.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        available: existsSync(item.absPath),
        thumbnailUrl: existsSync(item.thumbnailPath)
          ? `/api/claw/office/ppt-create/templates/${encodeURIComponent(item.id)}/thumbnail`
          : undefined,
      })),
    });
  });

  app.get("/api/claw/office/ppt-create/list", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || "").trim();
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const workspace = resolveRuntimeWorkspace(claw, adoptId);
      const { root } = ensurePptRoot(workspace);
      res.json({ records: readPptIndex(root).map((record) => recordForResponse(record, adoptId)) });
    } catch (err: any) {
      console.error("[office-ppt] list error:", err);
      res.status(500).json({ error: err.message || "list failed" });
    }
  });

  app.delete("/api/claw/office/ppt-create/:taskId", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || req.headers["x-adopt-id"] || "").trim();
      const taskId = safeTaskId(String(req.params.taskId || ""));
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      if (!taskId) return res.status(400).json({ error: "taskId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const workspace = resolveRuntimeWorkspace(claw, adoptId);
      const result = deleteRecord(workspace, taskId);
      res.json({ ok: true, deleted: result.deleted });
    } catch (err: any) {
      console.error("[office-ppt] delete error:", err);
      res.status(500).json({ error: err.message || "PPT 历史删除失败" });
    }
  });

  app.post("/api/claw/office/ppt-create/outline", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || req.headers["x-adopt-id"] || "").trim();
      const body = (req.body || {}) as any;
      const taskId = safeTaskId(String(body.taskId || crypto.randomUUID()));
      const contextPaths = Array.isArray(body.contextPaths)
        ? body.contextPaths.map(safeRel).filter(Boolean) as string[]
        : [];
      const instruction = String(body.instruction || "").trim().slice(0, 5000);
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const workspace = resolveRuntimeWorkspace(claw, adoptId);
      for (const rel of contextPaths) {
        const abs = safeJoin(workspace, rel);
        if (!abs || !existsSync(abs)) return res.status(404).json({ error: `材料不存在: ${rel}` });
      }
      const template = resolveTemplateToWorkspace({
        workspace,
        taskId,
        templateId: String(body.templateId || "huawei-light"),
        templatePath: String(body.templatePath || ""),
      });
      const runtimeAgentId = resolveRuntimeAgentId(adoptId, String((claw as any).agentId || ""));
      const taskDirs = ensureTaskDirs(workspace, taskId);
      const createdAt = new Date().toISOString();
      const requestPath = taskDirs.rel("request.md");
      const outlinePath = taskDirs.outputRel("outline.md");
      const title = `${safeFileStem(instruction.split(/[，。,.!?！？\n]/)[0] || template.templateName || "PPT")} 制作`;
      writeFileSync(path.join(workspace, requestPath), [
        `# ${title}`,
        "",
        `- 时间：${createdAt}`,
        `- 模板：${template.templateName}`,
        `- 模板文件：${template.templatePath}`,
        ...contextPaths.map((item) => `- 材料：${item}`),
        "",
        "## 制作要求",
        "",
        instruction || "生成一份商务汇报 PPT。",
        "",
      ].join("\n"), "utf8");

      const outline = await callOpenClawOffice({
        claw,
        runtimeAgentId,
        sessionChannel: "office-ppt-outline",
        sessionConversationId: taskId,
        prompt: buildOutlinePrompt({ ...template, contextPaths, instruction, outlinePath }),
        brandSystemPrompt: "你是企业 PPT 策划助手，负责使用 office-ppt-outline 技能方法，把资料和用户要求变成清晰、可审核、可机器生成 PPTX 的分页大纲。",
      });
      writeFileSync(path.join(workspace, outlinePath), `${outline}\n`, "utf8");
      const record: PptCreateRecord = {
        id: taskId,
        title,
        createdAt,
        updatedAt: new Date().toISOString(),
        status: "planned",
        ...template,
        contextPaths,
        instruction,
        requestPath,
        outlinePath,
        outline,
      };
      upsertRecord(workspace, record);
      res.json({ record: recordForResponse(record, adoptId) });
    } catch (err: any) {
      console.error("[office-ppt] outline error:", err);
      res.status(500).json({ error: err.message || "PPT 大纲生成失败" });
    }
  });

  app.post("/api/claw/office/ppt-create/outline-stream", async (req, res) => {
    let upstreamReq: http.ClientRequest | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    const writeEvent = (event: string, data: any) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    req.on("close", () => {
      if (!res.writableEnded && upstreamReq) upstreamReq.destroy();
      if (heartbeat) clearInterval(heartbeat);
    });

    try {
      const adoptId = String(req.query.adoptId || req.headers["x-adopt-id"] || "").trim();
      const body = (req.body || {}) as any;
      const taskId = safeTaskId(String(body.taskId || crypto.randomUUID()));
      const contextPaths = Array.isArray(body.contextPaths)
        ? body.contextPaths.map(safeRel).filter(Boolean) as string[]
        : [];
      const instruction = String(body.instruction || "").trim().slice(0, 5000);
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;

      const workspace = resolveRuntimeWorkspace(claw, adoptId);
      for (const rel of contextPaths) {
        const abs = safeJoin(workspace, rel);
        if (!abs || !existsSync(abs)) return res.status(404).json({ error: `材料不存在: ${rel}` });
      }
      const template = resolveTemplateToWorkspace({
        workspace,
        taskId,
        templateId: String(body.templateId || "huawei-light"),
        templatePath: String(body.templatePath || ""),
      });
      const runtimeAgentId = resolveRuntimeAgentId(adoptId, String((claw as any).agentId || ""));
      const taskDirs = ensureTaskDirs(workspace, taskId);
      const createdAt = new Date().toISOString();
      const requestPath = taskDirs.rel("request.md");
      const outlinePath = taskDirs.outputRel("outline.md");
      const title = `${safeFileStem(instruction.split(/[，。,.!?！？\n]/)[0] || template.templateName || "PPT")} 制作`;
      writeFileSync(path.join(workspace, requestPath), [
        `# ${title}`,
        "",
        `- 时间：${createdAt}`,
        `- 模板：${template.templateName}`,
        `- 模板文件：${template.templatePath}`,
        ...contextPaths.map((item) => `- 材料：${item}`),
        "",
        "## 制作要求",
        "",
        instruction || "生成一份商务汇报 PPT。",
        "",
      ].join("\n"), "utf8");

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      (res as any).flushHeaders?.();
      heartbeat = setInterval(() => writeEvent("ping", { ts: Date.now() }), 15_000);

      writeEvent("stage", { id: "prepare", label: "准备模板和材料", status: "running" });
      writeEvent("stage", { id: "prepare", label: "准备模板和材料", status: "done" });
      writeEvent("stage", { id: "outline", label: "生成分页大纲", status: "running" });

      const outline = await streamOpenClawOffice({
        claw,
        runtimeAgentId,
        sessionChannel: "office-ppt-outline",
        sessionConversationId: taskId,
        prompt: buildOutlinePrompt({ ...template, contextPaths, instruction, outlinePath }),
        brandSystemPrompt: "你是企业 PPT 策划助手，负责使用 office-ppt-outline 技能方法，把资料和用户要求变成清晰、可审核、可机器生成 PPTX 的分页大纲。",
        onRequest: (r) => { upstreamReq = r; },
        onDelta: (text) => writeEvent("delta", { text }),
        onEvent: (event, payload) => {
          if (event === "tool_call" || event === "tool_result" || event.includes("tool")) {
            writeEvent("tool", { event, payload });
          } else if (event === "upstream_error") {
            writeEvent("warning", { event, payload });
          }
        },
      });

      writeFileSync(path.join(workspace, outlinePath), `${outline}\n`, "utf8");
      const record: PptCreateRecord = {
        id: taskId,
        title,
        createdAt,
        updatedAt: new Date().toISOString(),
        status: "planned",
        ...template,
        contextPaths,
        instruction,
        requestPath,
        outlinePath,
        outline,
      };
      upsertRecord(workspace, record);
      writeEvent("stage", { id: "outline", label: "生成分页大纲", status: "done" });
      writeEvent("record", { record: recordForResponse(record, adoptId) });
      writeEvent("done", { ok: true });
      if (heartbeat) clearInterval(heartbeat);
      res.end();
    } catch (err: any) {
      console.error("[office-ppt] outline stream error:", err);
      if (heartbeat) clearInterval(heartbeat);
      writeEvent("error", { error: err.message || "PPT 大纲生成失败" });
      if (!res.writableEnded) res.end();
    }
  });

  app.post("/api/claw/office/ppt-create/apply", async (req, res) => {
    try {
      const adoptId = String(req.query.adoptId || req.headers["x-adopt-id"] || "").trim();
      const taskId = safeTaskId(String((req.body as any)?.taskId || ""));
      if (!adoptId) return res.status(400).json({ error: "adoptId required" });
      if (!taskId) return res.status(400).json({ error: "taskId required" });
      const claw = await requireClawOwner(req, res, adoptId);
      if (!claw) return;
      const workspace = resolveRuntimeWorkspace(claw, adoptId);
      const { root } = ensurePptRoot(workspace);
      const records = readPptIndex(root);
      const record = records.find((item) => item?.id === taskId);
      if (!record) return res.status(404).json({ error: "PPT 任务不存在" });
      if (!record.outline) return res.status(400).json({ error: "请先生成 PPT 大纲" });

      const taskDirs = ensureTaskDirs(workspace, taskId);
      const resultPath = taskDirs.outputRel("slides.pptx");
      const editableResultPath = taskDirs.outputRel("slides-editable.pptx");
      const imageDirRel = taskDirs.outputRel("slide-images");
      const resultNotePath = taskDirs.outputRel("ppt-result.md");
      const htmlPreviewPath = taskDirs.outputRel("slides-preview.html");
      const qualityReportPath = taskDirs.outputRel("quality-report.json");
      const blueprint = resolveBlueprint(record.outline, record.title || "PPT 制作");
      writeFileSync(path.join(workspace, htmlPreviewPath), renderDeckHtml({
        blueprint,
        templateName: record.templateName || "PPT 模板",
        generatedAt: new Date().toISOString(),
      }), "utf8");
      await generatePptxFromBlueprint({
        blueprint,
        outputAbs: path.join(workspace, editableResultPath),
        templateName: record.templateName || "PPT 模板",
        templatePath: record.templatePath,
        instruction: record.instruction || "",
      });
      const qualityReport = buildQualityReport({
        blueprint,
        pptxPath: path.join(workspace, editableResultPath),
      });
      writeFileSync(path.join(workspace, qualityReportPath), JSON.stringify(qualityReport, null, 2), "utf8");
      if (!qualityReport.ok) {
        const first = qualityReport.findings.find((item) => item.severity === "error");
        throw new Error(first?.message || "PPTX 质量校验失败");
      }
      await generateImagePptxFromBlueprint({
        blueprint,
        outputAbs: path.join(workspace, resultPath),
        imageDirAbs: path.join(workspace, imageDirRel),
        templateName: record.templateName || "PPT 模板",
        templateAbs: path.join(workspace, record.templatePath),
      });
      const resultSummary = buildResultSummary({
        blueprint,
        templateName: record.templateName || "PPT 模板",
        templatePath: record.templatePath,
        resultPath,
        editableResultPath,
        resultNotePath,
        htmlPreviewPath,
        qualityReportPath,
        qualityOk: qualityReport.ok,
      });
      writeFileSync(path.join(workspace, resultNotePath), `${resultSummary}\n`, "utf8");
      const resultAbs = path.join(workspace, resultPath);
      const nextRecord: PptCreateRecord = {
        ...record,
        updatedAt: new Date().toISOString(),
        status: "completed",
        resultPath: existsSync(resultAbs) ? resultPath : undefined,
        editableResultPath: existsSync(path.join(workspace, editableResultPath)) ? editableResultPath : undefined,
        resultNotePath,
        htmlPreviewPath,
        qualityReportPath,
        resultSummary,
      };
      if (!nextRecord.resultPath) throw new Error("PPTX 文件生成失败");
      upsertRecord(workspace, nextRecord);
      res.json({ record: recordForResponse(nextRecord, adoptId) });
    } catch (err: any) {
      console.error("[office-ppt] apply error:", err);
      res.status(500).json({ error: err.message || "PPT 生成失败" });
    }
  });
}
