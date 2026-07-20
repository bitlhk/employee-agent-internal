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
});
