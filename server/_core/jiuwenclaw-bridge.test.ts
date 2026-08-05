import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  buildJiuwenAgentServerChatRequest,
  buildJiuwenAgentServerPermissionAnswerRequest,
  buildJiuwenFinalSnapshot,
  buildJiuwenRunDescriptor,
  buildJiuwenTextDelta,
  collectRecentWorkspaceFiles,
  formatJiuwenTextSectionDelta,
  inferSkillIdFromJiuwenPayload,
  normalizeJiuwenPermissionRequest,
  pickJiuwenText,
} from "./jiuwenclaw-bridge";

describe("jiuwenclaw bridge audit helpers", () => {
  it("publishes stable run and session identifiers for terminal reconciliation", () => {
    expect(buildJiuwenRunDescriptor({
      clientRunId: "client-run-1",
      requestId: "request-1",
      sessionId: "session-1",
    })).toEqual({
      runId: "client-run-1",
      requestId: "request-1",
      sessionId: "session-1",
    });
    expect(buildJiuwenRunDescriptor({
      requestId: "request-fallback",
      sessionId: "session-2",
    }).runId).toBe("request-fallback");
  });

  it("separates post-tool text without adding duplicate blank lines", () => {
    expect(formatJiuwenTextSectionDelta("查询完成。", true)).toBe("\n\n查询完成。");
    expect(formatJiuwenTextSectionDelta("\n\n查询完成。", true)).toBe("\n\n查询完成。");
    expect(formatJiuwenTextSectionDelta("继续输出", false)).toBe("继续输出");
  });

  it("infers skill ids from jiuwenswarm tool arguments", () => {
    expect(inferSkillIdFromJiuwenPayload({ command: "python skills/wealth-manager-assistant/run.py" })).toBe("wealth-manager-assistant");
    expect(inferSkillIdFromJiuwenPayload({ skillId: "insurance-advisor-pro" })).toBe("insurance-advisor-pro");
  });

  it("keeps ask-user questions separate from security permissions", () => {
    const request = normalizeJiuwenPermissionRequest("chat.ask_user_question", {
      request_id: "ask-1",
      source: "ask_user_interrupt",
      questions: [
        {
          header: "客户类型",
          question: "请选择客户类型",
          options: [{ label: "新保客户" }, { label: "续保客户" }],
        },
        {
          header: "难度",
          question: "请选择难度",
          options: [{ label: "简单" }, { label: "困难" }],
        },
      ],
    }, "fallback");

    expect(request).toMatchObject({
      requestId: "ask-1",
      source: "ask_user_interrupt",
      kind: "question",
      title: "客户类型",
    });
    expect(request?.questions).toHaveLength(2);
    expect(request?.questions?.[1].options[1].label).toBe("困难");
    expect(request?.options.map((option) => option.label)).toEqual(["新保客户", "续保客户"]);
  });

  it("keeps real permission interrupts on the allow or reject contract", () => {
    const request = normalizeJiuwenPermissionRequest("chat.permission", {
      request_id: "permission-1",
      source: "permission_interrupt",
      question: "工具 bash 需要授权",
    }, "fallback");

    expect(request).toMatchObject({ kind: "permission", title: "权限审批" });
    expect(request?.options.map((option) => option.value)).toEqual(["本次允许", "拒绝"]);
    expect(request).toMatchObject({ riskLevel: "medium", allowAlways: false });
  });

  it("exposes persistent approval only when the runtime offers it and the action is not high risk", () => {
    const request = normalizeJiuwenPermissionRequest("chat.permission", {
      request_id: "permission-read",
      source: "permission_interrupt",
      tool_name: "read_file",
      question: "读取工作区文件",
      options: [
        { label: "本次允许", value: "allow_once" },
        { label: "总是允许", value: "allow_always" },
        { label: "拒绝", value: "reject" },
      ],
    }, "fallback");

    expect(request).toMatchObject({
      riskLevel: "low",
      reasonCode: "read_only",
      allowAlways: true,
    });
  });

  it("returns every ask-user answer to JiuwenSwarm in question order", () => {
    const request = buildJiuwenAgentServerPermissionAnswerRequest({
      envelopeRequestId: "answer-1",
      permissionRequestId: "ask-1",
      serviceId: "linggan",
      agentId: "jiuwen_lgj-test",
      sessionId: "session-1",
      channelId: "lgj-test",
      workspaceDir: "/tmp/workspace",
      selectedOption: "续保客户",
      source: "ask_user_interrupt",
      answers: [
        { selectedOptions: ["续保客户"], customInput: "" },
        { selectedOptions: ["困难"], customInput: "" },
      ],
    });

    expect(request.params.answers).toEqual([
      { selected_options: ["续保客户"], custom_input: "" },
      { selected_options: ["困难"], custom_input: "" },
    ]);
  });

  it("extracts final text nested in an AgentServer completion payload", () => {
    expect(pickJiuwenText({ payload: { event_type: "chat.final", content: "模型不支持图片理解" } })).toBe(
      "模型不支持图片理解",
    );
  });

  it("publishes chat.final as an authoritative Markdown snapshot", () => {
    const markdown = "## 结果\n\n| # | 名称 |\n|---|---|\n| 1 | 示例 |";
    expect(buildJiuwenFinalSnapshot(markdown, "/tmp/workspace")).toEqual({
      __final_text: markdown,
    });
  });

  it("publishes only whitelisted knowledge citations in the final snapshot", () => {
    expect(buildJiuwenFinalSnapshot("依据[知识1 第 27 页]，未知[知识8]。", "/tmp/workspace", [1, 2])).toEqual({
      __final_text: "依据[知识1]，未知。",
    });
  });

  it("labels streamed text as a delta instead of guessing from its prefix", () => {
    expect(buildJiuwenTextDelta("#")).toEqual({
      __text_mode: "delta",
      choices: [{ delta: { content: "#" }, index: 0 }],
    });
  });

  it("does not report a file uploaded before the agent run as generated output", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-workspace-files-"));
    try {
      const cutoff = Date.now();
      const uploaded = path.join(root, "uploaded.txt");
      const generated = path.join(root, "generated.txt");
      const redirectedVersion = path.join(root, "=3.0.0");
      writeFileSync(uploaded, "input", "utf8");
      utimesSync(uploaded, new Date(cutoff - 5000), new Date(cutoff - 5000));
      writeFileSync(generated, "output", "utf8");
      utimesSync(generated, new Date(cutoff + 1000), new Date(cutoff + 1000));
      writeFileSync(redirectedVersion, "", "utf8");
      utimesSync(redirectedVersion, new Date(cutoff + 1000), new Date(cutoff + 1000));

      expect(collectRecentWorkspaceFiles(root, cutoff).map((file) => file.name)).toEqual(["generated.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not expose JiuwenSwarm context offload files as generated output", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-workspace-context-"));
    try {
      const cutoff = Date.now();
      const contextDir = path.join(root, "context", "session_context", "offload");
      mkdirSync(contextDir, { recursive: true });
      writeFileSync(path.join(contextDir, "MessageSummaryOffloader.json"), "{}", "utf8");
      const report = path.join(root, "risk-report.md");
      writeFileSync(report, "report", "utf8");
      utimesSync(report, new Date(cutoff + 1000), new Date(cutoff + 1000));

      expect(collectRecentWorkspaceFiles(root, cutoff).map((file) => file.path)).toEqual(["risk-report.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes uploaded workspace images to AgentServer as structured media", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ea-workspace-image-"));
    try {
      const uploadDir = path.join(root, "prompt_attachment");
      mkdirSync(uploadDir, { recursive: true });
      const imagePath = path.join(uploadDir, "risk.png");
      writeFileSync(imagePath, "png-data", "utf8");
      const message = [
        "请看一下图片。",
        "",
        "[已上传附件]",
        "- risk.png (8 B) -> workspace path: prompt_attachment/risk.png",
        "",
        "需要读取附件内容时，请使用上面的 workspace path。",
      ].join("\n");

      const request = buildJiuwenAgentServerChatRequest({
        requestId: "request-image",
        serviceId: "linggan",
        agentId: "jiuwen_lgj-test",
        sessionId: "session-image",
        channelId: "lgj-test",
        message,
        workspaceDir: root,
        model: "glm-5.2",
      });

      expect(request.params.media_items).toEqual([{
        type: "image",
        filename: "risk.png",
        path: imagePath,
        mime_type: "image/png",
        size_bytes: 8,
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
