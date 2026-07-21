import { describe, expect, it } from "vitest";

import {
  buildA2ATaskRequest,
  extractA2ATaskResult,
  type A2AEndpointConfig,
} from "./a2a-expert-client";

describe("A2A expert profiles", () => {
  it("preserves the existing standard text-only A2A request by default", () => {
    const request = buildA2ATaskRequest("review this", { stream: true });

    expect(request.body.method).toBe("message/stream");
    expect(request.body.params.message).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "review this" }],
    });
    expect(request.body.params.message).not.toHaveProperty("contextId");
    expect(request.body.params).not.toHaveProperty("metadata");
  });

  it("uses an explicit stable runtime context when the caller supplies one", () => {
    const request = buildA2ATaskRequest("continue", {}, { contextId: "ea-context-123" });

    expect(request.contextId).toBe("ea-context-123");
    expect(request.body.params.message.contextId).toBe("ea-context-123");
  });

  it("adds a runtime interaction response without changing the static profile", () => {
    const request = buildA2ATaskRequest("continue", {}, {
      contextId: "ea-context-123",
      dataPart: {
        schema: "ea.interaction.v1",
        kind: "response",
        response: { interactionId: "outline-1", optionId: "brief" },
      },
      dataPartMetadata: { "ea.interaction": true, version: "1.0.0" },
    });

    expect(request.body.params.message.parts).toEqual([
      { kind: "text", text: "continue" },
      {
        kind: "data",
        data: {
          schema: "ea.interaction.v1",
          kind: "response",
          response: { interactionId: "outline-1", optionId: "brief" },
        },
        metadata: { "ea.interaction": true, version: "1.0.0" },
      },
    ]);
  });

  it("builds extended A2A data and metadata from configuration", () => {
    const config: A2AEndpointConfig = {
      method: "message/stream",
      requestProfile: {
        idVersion: 7,
        textTemplate: "Question: {{prompt}}",
        messageKind: "message",
        includeContextId: true,
        includeTaskId: true,
        messageFields: { referenceTaskIds: [] },
        dataPart: { chatMode: "0", index: "{{uuid}}", timezone: "Asia/Shanghai" },
        dataPartMetadata: { key: "example.a2a", version: "1.0.0" },
        paramsMetadata: { activatedSkills: [] },
      },
    };

    const request = buildA2ATaskRequest("hello", config);

    expect(request.contextId).toBeTruthy();
    expect(request.taskId).toBeTruthy();
    expect(request.contextId?.split("-")[2]?.startsWith("7")).toBe(true);
    expect(request.body.params.message).toMatchObject({
      kind: "message",
      contextId: request.contextId,
      taskId: request.taskId,
      referenceTaskIds: [],
      parts: [
        { kind: "text", text: "Question: hello" },
        {
          kind: "data",
          data: { chatMode: "0", index: expect.any(String), timezone: "Asia/Shanghai" },
          metadata: { key: "example.a2a", version: "1.0.0" },
        },
      ],
    });
    expect(request.body.params.metadata).toEqual({ activatedSkills: [] });
  });

  it("extracts configured data artifacts without vendor-specific code", () => {
    const result = extractA2ATaskResult([
      {
        result: {
          kind: "artifact-update",
          taskId: "remote-1",
          artifact: {
            artifactId: "result-1",
            name: "agentResult",
            parts: [{ kind: "data", data: { data: "# Verified\n\nResult" } }],
          },
        },
      },
    ], {
      resultProfile: { artifactNames: ["agentResult"] },
    });

    expect(result).toEqual({ text: "# Verified\n\nResult", remoteTaskId: "remote-1" });
  });

  it("does not treat unrelated data status artifacts as a configured result", () => {
    const result = extractA2ATaskResult([
      {
        result: {
          final: true,
          contextId: "context-1",
          artifact: {
            name: "UIState",
            parts: [{ kind: "data", data: { data: { message: "working" } } }],
          },
        },
      },
    ], {
      resultProfile: { artifactNames: ["agentResult"] },
    });

    expect(result).toEqual({ text: "", remoteTaskId: "context-1" });
  });

  it("keeps response artifact snapshots compatible with existing A2A agents", () => {
    const result = extractA2ATaskResult([
      {
        result: {
          kind: "artifact-update",
          contextId: "context-1",
          artifact: {
            artifactId: "run_response",
            name: "response",
            parts: [{ kind: "text", text: "first" }],
          },
        },
      },
      {
        result: {
          kind: "artifact-update",
          contextId: "context-1",
          artifact: {
            artifactId: "run_response",
            name: "response",
            parts: [{ kind: "text", text: "final" }],
          },
        },
      },
    ], {});

    expect(result).toEqual({ text: "final", remoteTaskId: "context-1" });
  });

  it("extracts a standard input-required interaction without rendering its JSON as text", () => {
    const result = extractA2ATaskResult([{
      result: {
        kind: "task",
        id: "remote-task-1",
        contextId: "context-1",
        status: {
          state: "input-required",
          message: {
            kind: "message",
            role: "agent",
            parts: [
              { kind: "text", text: "我已经完成内容分析，请确认下一步。" },
              {
                kind: "data",
                data: {
                  schema: "ea.interaction.v1",
                  interactionId: "outline-1",
                  type: "single_choice",
                  title: "请选择结构",
                  options: [
                    { id: "brief", label: "简洁汇报" },
                    { id: "full", label: "完整方案", recommended: true },
                  ],
                  allowCustom: true,
                  allowNote: true,
                  submitMode: "confirm",
                },
              },
            ],
          },
        },
      },
    }], {});

    expect(result).toMatchObject({
      text: "我已经完成内容分析，请确认下一步。",
      remoteTaskId: "remote-task-1",
      state: "input-required",
      interaction: { interactionId: "outline-1", title: "请选择结构" },
    });
  });

  it("extracts standard A2A file parts as structured artifacts", () => {
    const result = extractA2ATaskResult([{
      result: {
        kind: "message",
        role: "agent",
        contextId: "context-files",
        parts: [
          { kind: "text", text: "报告已经生成。" },
          {
            kind: "file",
            file: {
              name: "report.pdf",
              mimeType: "application/pdf",
              uri: "https://files.example.com/report.pdf?signature=one",
              size: 2048,
            },
            metadata: { id: "report-pdf", "ea.role": "preview" },
          },
          {
            kind: "file",
            file: {
              name: "report.docx",
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              uri: "https://files.example.com/report.docx?signature=two",
            },
            metadata: { id: "report-docx", "ea.role": "primary" },
          },
        ],
      },
    }], {});

    expect(result).toMatchObject({
      text: "报告已经生成。",
      remoteTaskId: "context-files",
      artifacts: [
        {
          id: "report-pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 2048,
          role: "preview",
        },
        {
          id: "report-docx",
          name: "report.docx",
          role: "primary",
        },
      ],
    });
  });

  it("extracts the EA artifact manifest compatibility extension", () => {
    const result = extractA2ATaskResult([{
      result: {
        kind: "message",
        role: "agent",
        parts: [
          { kind: "text", text: "完成" },
          {
            kind: "data",
            data: {
              schema: "ea.artifact-manifest.v1",
              artifacts: [{
                id: "chart-one",
                name: "chart.png",
                mimeType: "image/png",
                role: "preview",
                uri: "https://files.example.com/chart.png",
              }],
            },
          },
        ],
      },
    }], {});

    expect(result.artifacts).toEqual([expect.objectContaining({
      id: "chart-one",
      name: "chart.png",
      role: "preview",
    })]);
    expect(result.text).toBe("完成");
  });
});
