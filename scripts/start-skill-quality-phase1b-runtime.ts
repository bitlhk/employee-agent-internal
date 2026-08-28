import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "dotenv";

async function main(): Promise<void> {
  const targetRoot = path.resolve(
    process.env.EA_SKILL_EVAL_JIUWEN_ROOT ||
      path.join(os.tmpdir(), "employee-agent-skill-quality-phase1b-jiuwen")
  );
  const temporaryRoot = path.resolve(os.tmpdir());
  if (!targetRoot.startsWith(`${temporaryRoot}${path.sep}`)) {
    throw new Error(`Refusing non-temporary Jiuwen evaluation root: ${targetRoot}`);
  }
  const envPath = path.join(targetRoot, "config", ".env");
  if (!existsSync(envPath)) {
    throw new Error("Phase 1B Jiuwen environment is missing; run skills:quality:phase1b:jiuwen-config first");
  }
  const parsedEnv = parse(readFileSync(envPath));
  if (!String(parsedEnv.INTERNAL_API_KEY || "").trim()) {
    throw new Error("The isolated Jiuwen environment has no INTERNAL_API_KEY");
  }
  const runtimeUrl = new URL(
    process.env.EA_SKILL_EVAL_RUNTIME_BASE_URL || "http://127.0.0.1:5199"
  );
  if (!['127.0.0.1', 'localhost', '::1'].includes(runtimeUrl.hostname)) {
    throw new Error("Phase 1B EA Runtime is restricted to a loopback address");
  }
  const runtimePort = runtimeUrl.port || "80";
  const agentServerPort = String(process.env.EA_SKILL_EVAL_AGENTSERVER_PORT || "18093");
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) throw new Error(`Local tsx executable not found: ${tsx}`);
  const child = spawn(tsx, ["server/_core/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...parsedEnv,
      PORT: runtimePort,
      NODE_ENV: "production",
      JIUWENCLAW_AGENTSERVER_WS_URL: `ws://127.0.0.1:${agentServerPort}`,
    },
    stdio: "inherit",
  });
  const terminate = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => terminate("SIGINT"));
  process.once("SIGTERM", () => terminate("SIGTERM"));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = exitCode;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
