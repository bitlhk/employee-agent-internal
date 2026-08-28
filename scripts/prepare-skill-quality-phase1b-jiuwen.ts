import "dotenv/config";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function replaceEnvValue(source: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "mu");
  return pattern.test(source)
    ? source.replace(pattern, line)
    : `${source.trimEnd()}\n${line}\n`;
}

function main(): void {
  const runtimeBaseUrl = String(
    process.env.EA_SKILL_EVAL_RUNTIME_BASE_URL || "http://127.0.0.1:5199"
  ).replace(/\/$/u, "");
  const runtimeUrl = new URL(runtimeBaseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(runtimeUrl.hostname)) {
    throw new Error("Phase 1B Jiuwen configuration is restricted to a loopback EA Runtime");
  }
  const sourceRoot = path.resolve(
    process.env.EA_SKILL_EVAL_JIUWEN_SOURCE_ROOT ||
      path.join(os.homedir(), ".jiuwenswarm")
  );
  const targetRoot = path.resolve(
    process.env.EA_SKILL_EVAL_JIUWEN_ROOT ||
      path.join(os.tmpdir(), "employee-agent-skill-quality-phase1b-jiuwen")
  );
  const allowedTargetParent = path.resolve(os.tmpdir());
  if (!targetRoot.startsWith(`${allowedTargetParent}${path.sep}`)) {
    throw new Error(`Refusing non-temporary Jiuwen evaluation root: ${targetRoot}`);
  }

  const sourceConfigDir = path.join(sourceRoot, "config");
  const targetConfigDir = path.join(targetRoot, "config");
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  cpSync(sourceConfigDir, targetConfigDir, { recursive: true });

  const configPath = path.join(targetConfigDir, "config.yaml");
  const sourceConfig = readFileSync(configPath, "utf8");
  const configured = sourceConfig.replace(
    /http:\/\/127\.0\.0\.1:5180\/api\/internal\//gu,
    `${runtimeBaseUrl}/api/internal/`
  );
  if (configured === sourceConfig) {
    throw new Error("No internal EA MCP URL was rewritten in the Jiuwen evaluation config");
  }
  writeFileSync(configPath, configured, { encoding: "utf8", mode: 0o600 });

  const envPath = path.join(targetConfigDir, ".env");
  let envText = readFileSync(envPath, "utf8");
  envText = replaceEnvValue(envText, "JIUWENSWARM_DATA_DIR", targetRoot);
  envText = replaceEnvValue(envText, "WORKFORCE_AGENT_INTERNAL_BASE_URL", runtimeBaseUrl);
  envText = replaceEnvValue(
    envText,
    "LINGGAN_CALLBACK_URL",
    `${runtimeBaseUrl}/api/internal/jiuwen/linggan/callback`
  );
  writeFileSync(envPath, envText, { encoding: "utf8", mode: 0o600 });

  process.stdout.write(
    `${JSON.stringify({ targetRoot, envPath, configPath, runtimeBaseUrl }, null, 2)}\n`
  );
}

main();
