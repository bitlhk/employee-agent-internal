import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { extractJiuwenChatMessages } from "./chat-history";

it("filters old artifact receipts and inferred internal writes while restoring real exports", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "ea-history-internal-artifacts-")
  );
  try {
    const workspace = path.join(root, "workspace");
    const session = path.join(root, "session");
    mkdirSync(session, { recursive: true });
    const internal = [
      "SOUL.md",
      "AGENT.md",
      "HEARTBEAT.md",
      "coding_memory/MEMORY.md",
    ];
    const visible = ["output/report.pdf", "output/AGENT.md"];
    for (const file of [...internal, ...visible]) {
      mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
      writeFileSync(path.join(workspace, file), "fixture");
    }
    const registryPath = path.join(session, ".ea-generated-files.json");
    const registryText = JSON.stringify({
      version: 1,
      runs: {
        r1: {
          adoptId: "lgj-demo",
          requestId: "r1",
          updatedAt: "2026-10-20T00:00:00Z",
          files: [...internal, ...visible].map(file => ({
            name: path.basename(file),
            path: file,
            size: 7,
          })),
        },
      },
    });
    writeFileSync(registryPath, registryText);
    const historyPath = path.join(session, "history.jsonl");
    writeFileSync(
      historyPath,
      [
        ...internal.map((file, i) => ({
          role: "assistant",
          request_id: "r1",
          event_type: "chat.tool_call",
          timestamp: 100,
          tool_call: {
            name: "write_file",
            tool_call_id: `c${i}`,
            arguments: JSON.stringify({
              file_path: path.join(workspace, file),
            }),
          },
        })),
        {
          role: "assistant",
          request_id: "r1",
          event_type: "chat.final",
          timestamp: 101,
          content: "查询完成。",
        },
      ]
        .map(row => JSON.stringify(row))
        .join("\n")
    );
    const messages = extractJiuwenChatMessages(
      historyPath,
      200,
      "lgj-demo",
      workspace
    );
    const files = messages
      .flatMap(message => message.toolCalls || [])
      .flatMap(tool => tool.outputFiles || []);
    expect(files.map(file => file.wsPath).sort()).toEqual(visible.sort());
    expect(messages.find(message => message.role === "assistant")?.text).toBe(
      "查询完成。"
    );
    expect(readFileSync(registryPath, "utf8")).toBe(registryText);
    for (const file of internal)
      expect(readFileSync(path.join(workspace, file), "utf8")).toBe("fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
