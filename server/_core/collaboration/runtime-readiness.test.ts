import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { assertCollaborationRuntimeReady } from "./runtime-readiness";
async function withServer(
  payload: Record<string, unknown>,
  action: (url: string) => Promise<void>
) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  server.on("connection", socket =>
    socket.on("message", raw => {
      const request = JSON.parse(String(raw));
      expect(request.method).toBe("command.status");
      expect(request.params).toEqual({ action: "ea-collaboration" });
      socket.send(
        JSON.stringify({
          request_id: request.request_id,
          is_final: true,
          status: "succeeded",
          body: { result: payload },
        })
      );
    })
  );
  try {
    await action(
      `ws://127.0.0.1:${(server.address() as { port: number }).port}`
    );
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
describe("running process compatibility probe", () => {
  it("accepts only a running service with the installed isolated-execution protocol", async () => {
    await withServer(
      { ea_collaboration_scope_version: 1, ea_conversation_context_version: 1 },
      async url => {
        await expect(
          assertCollaborationRuntimeReady(url)
        ).resolves.toBeUndefined();
      }
    );
  });
  it("rejects old runtime responses before sending user data or calling a model", async () => {
    await withServer({ ea_collaboration_scope_version: 1 }, async url => {
      await expect(assertCollaborationRuntimeReady(url)).rejects.toThrow(
        "协作对话"
      );
    });
    await withServer({ healthy: true }, async url => {
      await expect(assertCollaborationRuntimeReady(url)).rejects.toThrow(
        "重启"
      );
    });
    await withServer({ ea_collaboration_scope_version: 99 }, async url => {
      await expect(assertCollaborationRuntimeReady(url)).rejects.toThrow(
        "补丁"
      );
    });
  });
});
