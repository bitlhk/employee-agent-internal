import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getEaAssistantModelConfig } from "../server/_core/ea-assistant-model";

// Configure an already-installed, pinned JiuwenSwarm. Secrets are passed through
// stdin and protected config files, never command arguments or console output.
const python = process.argv.find(value => value.startsWith("--python="))?.slice(9);
const root = process.argv.find(value => value.startsWith("--root="))?.slice(7);
if (!python || !root) throw new Error("--python and --root are required");
const model = getEaAssistantModelConfig();
if (!model.apiKey) throw new Error("Existing model configuration is missing");
let env = readFileSync(".env", "utf8");
const values: Record<string, string> = {
  INTERNAL_API_KEY: process.env.INTERNAL_API_KEY || randomBytes(32).toString("hex"),
  INTERNAL_RUNTIME_TOKEN_SECRET: process.env.INTERNAL_RUNTIME_TOKEN_SECRET || randomBytes(32).toString("hex"),
  JIUWENCLAW_RUNTIME_ENABLED: "true", EA_COLLABORATION_RUNTIME_ENABLED: "true",
  JIUWENCLAW_HOME: path.resolve(root),
  JIUWENSWARM_DATA_DIR: path.resolve(root),
  JIUWENCLAW_AGENTSERVER_WS_URL: "ws://127.0.0.1:18092",
};
const result = spawnSync(python, [path.resolve("scripts/configure-local-collaboration-runtime.py"), "--root", path.resolve(root), "--ea-env", path.resolve(".env"), "--port", process.env.PORT || "5174"], {
  input: JSON.stringify({ ...values, apiKey: model.apiKey, baseUrl: model.baseUrl.replace(/\/chat\/completions$/, ""), model: model.model, runtimePython: path.resolve(python) }), encoding: "utf8",
});
if (result.status !== 0) throw new Error("Runtime configuration failed; see the protected runtime configuration, no secrets were logged");
for (const [key, value] of Object.entries(values)) {
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m"); env = pattern.test(env) ? env.replace(pattern, line) : `${env.trimEnd()}\n${line}\n`;
}
writeFileSync(".env", env);
console.log(JSON.stringify({ configured: true, root: path.resolve(root), model: model.model, transport: "JiuwenSwarm AgentServer", sharedProcess: true }));
