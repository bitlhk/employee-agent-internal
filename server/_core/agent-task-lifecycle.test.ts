import { describe, expect, it } from "vitest";
import { canRetryAgentTask, normalizeAgentTaskLifecycle } from "../../shared/agent-task-lifecycle";

describe("agent task lifecycle", () => {
  it("normalizes persisted and interaction states", () => {
    expect(normalizeAgentTaskLifecycle({ status: "pending" })).toBe("queued");
    expect(normalizeAgentTaskLifecycle({ status: "running" })).toBe("running");
    expect(normalizeAgentTaskLifecycle({ status: "succeeded", interactionStatus: "pending" })).toBe("waiting_user");
    expect(normalizeAgentTaskLifecycle({ status: "done" })).toBe("completed");
    expect(normalizeAgentTaskLifecycle({ status: "cancelled" })).toBe("cancelled");
  });

  it("allows retry only for failed terminal tasks", () => {
    expect(canRetryAgentTask({ status: "failed" })).toBe(true);
    expect(canRetryAgentTask({ status: "cancelled" })).toBe(true);
    expect(canRetryAgentTask({ status: "running" })).toBe(false);
    expect(canRetryAgentTask({ status: "succeeded", interactionStatus: "pending" })).toBe(false);
  });
});
