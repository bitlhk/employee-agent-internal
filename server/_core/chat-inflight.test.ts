import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetChatInflightForTests,
  __setChatInflightNowForTests,
  beginChatSessionDeletion,
  endChatSessionDeletion,
  getChatRun,
  makeChatLifecycleKey,
  markChatRunComplete,
  markChatRunStarted,
  touchChatRun,
  waitForChatSessionIdle,
} from "./chat-inflight";

describe("chat in-flight dedup registry", () => {
  beforeEach(() => {
    delete process.env.CHAT_SEND_DEDUP;
    delete process.env.CHAT_SEND_DEDUP_TTL_MS;
    __resetChatInflightForTests();
  });

  it("detects duplicate clientRunId within the same session", () => {
    const first = markChatRunStarted({
      sessionKey: "agent:a:main",
      clientRunId: "run-1",
      transport: "ws",
      message: "hello",
    });
    expect(first?.status).toBe("started");

    const duplicate = markChatRunStarted({
      sessionKey: "agent:a:main",
      clientRunId: "run-1",
      transport: "http",
      message: "hello",
    });
    expect(duplicate?.status).toBe("in_flight");
    expect(duplicate && "run" in duplicate ? duplicate.run.runId : "").toBe(first && "run" in first ? first.run.runId : "");
  });

  it("allows only one active run per sessionKey", () => {
    const first = markChatRunStarted({
      sessionKey: "agent:a:web:conv-1",
      clientRunId: "run-1",
      transport: "ws",
      message: "first",
    });
    expect(first?.status).toBe("started");

    const concurrent = markChatRunStarted({
      sessionKey: "agent:a:web:conv-1",
      clientRunId: "run-2",
      transport: "http",
      message: "second",
    });
    expect(concurrent?.status).toBe("in_flight");
    expect(concurrent && "run" in concurrent ? concurrent.run.clientRunId : "").toBe("run-1");
  });

  it("does not dedup across different sessions", () => {
    expect(markChatRunStarted({
      sessionKey: "agent:a:web:conv-1",
      clientRunId: "run-1",
      transport: "ws",
    })?.status).toBe("started");
    expect(markChatRunStarted({
      sessionKey: "agent:a:web:conv-2",
      clientRunId: "run-2",
      transport: "http",
    })?.status).toBe("started");
  });

  it("keeps a run alive when events refresh lastEventAt", () => {
    process.env.CHAT_SEND_DEDUP_TTL_MS = "1000";
    let current = 1000;
    __setChatInflightNowForTests(() => current);

    markChatRunStarted({ sessionKey: "s", clientRunId: "r", transport: "ws" });
    current = 1800;
    touchChatRun("s", "r", "delta");
    current = 2500;

    expect(getChatRun("s", "r")).toBeDefined();
  });

  it("expires stale runs by lastEventAt", () => {
    process.env.CHAT_SEND_DEDUP_TTL_MS = "1000";
    let current = 1000;
    __setChatInflightNowForTests(() => current);

    markChatRunStarted({ sessionKey: "s", clientRunId: "r", transport: "ws" });
    current = 2501;

    expect(getChatRun("s", "r")).toBeUndefined();
  });

  it("does not clear a run unless completion is explicitly marked", () => {
    markChatRunStarted({ sessionKey: "s", clientRunId: "r", transport: "ws" });

    expect(getChatRun("s", "r")).toBeDefined();
    markChatRunComplete("s", "r", "gateway_close");
    expect(getChatRun("s", "r")).toBeUndefined();
  });

  it("keeps a run after client_close when no terminal gateway event arrived", () => {
    markChatRunStarted({ sessionKey: "s", clientRunId: "r", transport: "ws" });

    // Browser/client close is intentionally not modeled as a completion signal.
    // The gateway may still be running the agent turn in the background.
    expect(getChatRun("s", "r")).toBeDefined();
  });

  it("fences new turns while a session is being deleted", () => {
    const key = makeChatLifecycleKey("lgj-owner", "conv-1");
    expect(beginChatSessionDeletion(key)).toBe(true);
    expect(markChatRunStarted({
      sessionKey: key,
      clientRunId: "run-1",
      transport: "http",
    })).toEqual({ status: "session_deleting" });
    endChatSessionDeletion(key);
    expect(markChatRunStarted({
      sessionKey: key,
      clientRunId: "run-1",
      transport: "http",
    })?.status).toBe("started");
  });

  it("waits for an active turn to quiesce before deletion", async () => {
    const key = makeChatLifecycleKey("lgj-owner", "conv-1");
    markChatRunStarted({ sessionKey: key, clientRunId: "run-1", transport: "http" });
    const idle = waitForChatSessionIdle(key, 200);
    markChatRunComplete(key, "run-1", "http_done");
    await expect(idle).resolves.toBe(true);
  });

  it("times out rather than deleting an active turn", async () => {
    const key = makeChatLifecycleKey("lgj-owner", "conv-1");
    markChatRunStarted({ sessionKey: key, clientRunId: "run-1", transport: "http" });
    await expect(waitForChatSessionIdle(key, 1)).resolves.toBe(false);
  });
});
