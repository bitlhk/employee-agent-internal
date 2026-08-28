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
  const configPath = path.join(targetRoot, "config", "config.yaml");
  if (!existsSync(envPath) || !existsSync(configPath)) {
    throw new Error("Phase 1B Jiuwen configuration is missing; run skills:quality:phase1b:jiuwen-config first");
  }
  const parsedEnv = parse(readFileSync(envPath));
  if (!String(parsedEnv.INTERNAL_API_KEY || "").trim()) {
    throw new Error("The isolated Jiuwen environment has no INTERNAL_API_KEY");
  }
  const python = path.resolve(
    process.env.EA_SKILL_EVAL_JIUWEN_PYTHON ||
      path.join(os.homedir(), ".venvs", "jiuwenswarm-023-ea1", "bin", "python")
  );
  if (!existsSync(python)) throw new Error(`Jiuwen Python Runtime not found: ${python}`);
  const port = String(process.env.EA_SKILL_EVAL_AGENTSERVER_PORT || "18093");
  const child = spawn(
    python,
    [
      "-m",
      "jiuwenswarm.server.app_agentserver",
      "--dotenv",
      envPath,
      "--port",
      port,
    ],
    {
      cwd: targetRoot,
      env: { ...process.env, ...parsedEnv },
      stdio: "inherit",
    }
  );
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
