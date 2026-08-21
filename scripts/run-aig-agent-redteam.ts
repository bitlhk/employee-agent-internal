import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { parse } from "dotenv";
import { APP_ROOT } from "../server/_core/helpers";
import { saveSecurityAssessment, type SecurityAssessmentRecord } from "../server/_core/security-assessment-store";

const execFileAsync = promisify(execFile);
const REPORT_DIR = path.join(APP_ROOT, "data", "security-assessments", "agent-redteam");

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function enabled(name: string): boolean {
  return String(process.env[name] || "false").trim().toLowerCase() === "true";
}

async function modelConfig() {
  const envPath = String(process.env.AIG_MODEL_ENV_PATH || path.join(process.env.HOME || "/home/ubuntu", ".jiuwenswarm", "config", ".env"));
  const file = envPath && existsSync(envPath) ? parse(await readFile(envPath)) : {};
  return {
    apiKey: String(process.env.LLM_API_KEY || file.API_KEY || "").trim(),
    baseUrl: String(process.env.LLM_BASE_URL || file.API_BASE || "").trim(),
    model: String(process.env.LLM_MODEL || file.MODEL_NAME || "").trim(),
  };
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function q(value: string): string {
  return JSON.stringify(value);
}

function summarize(report: any): SecurityAssessmentRecord["summary"] {
  const findings = Array.isArray(report?.results) ? report.results : [];
  const count = (level: string) => findings.filter((item: any) => String(item?.level || "").toLowerCase() === level).length;
  return {
    totalTests: Number(report?.total_tests || 0),
    vulnerableTests: Number(report?.vulnerable_tests || findings.length),
    high: count("high"),
    medium: count("medium"),
    low: count("low"),
  };
}

async function main() {
  if (!enabled("EA_AGENT_REDTEAM_ENABLED")) throw new Error("EA_AGENT_REDTEAM_ENABLED=true is required");
  if (!enabled("EA_AGENT_REDTEAM_ISOLATED_TARGET")) throw new Error("Refusing to scan a target not marked as isolated");
  const adoptId = required("EA_AGENT_REDTEAM_ADOPT_ID");
  const internalKey = required("INTERNAL_API_KEY");
  const baseUrl = String(process.env.EA_AGENT_REDTEAM_BASE_URL || "http://127.0.0.1:5180").replace(/\/$/, "");
  const targetLabel = String(process.env.EA_AGENT_REDTEAM_TARGET_LABEL || "EA isolated red-team target").trim();
  const scanner = String(process.env.AIG_AGENT_SCAN_BIN || "/home/ubuntu/.venvs/aig-skill-scan/bin/aig-agent-scan");
  const runId = `aigrt_${randomUUID()}`;
  const conversationId = `security-redteam-${runId}`;
  const config = {
    adoptId,
    baseUrl,
    restrictedMode: !enabled("EA_AGENT_REDTEAM_FULL_CAPABILITY_MODE"),
    skills: String(process.env.EA_AGENT_REDTEAM_SKILLS || "").trim(),
  };
  const configFingerprint = hash(JSON.stringify(config));
  const requestedAt = new Date().toISOString();
  await mkdir(REPORT_DIR, { recursive: true, mode: 0o700 });
  const providerPath = path.join(REPORT_DIR, `${runId}.provider.yaml`);
  const reportPath = path.join(REPORT_DIR, `${runId}.json`);
  saveSecurityAssessment({ key: "agent_redteam", provider: "Tencent AI-Infra-Guard / aig-agent-scan", status: "running", verdict: "pending", targetId: adoptId, targetLabel, isolated: true, configFingerprint, requestedAt });

  const providerYaml = `providers:\n  - id: ${q(`${baseUrl}/api/claw/chat-stream`)}\n    label: ${q(targetLabel)}\n    config:\n      url: ${q(baseUrl)}\n      endpoint: ${q("/api/claw/chat-stream")}\n      method: POST\n      timeout_ms: 180000\n      headers:\n        x-internal-key: ${q(internalKey)}\n      body:\n        adoptId: ${q(adoptId)}\n        message: ${q("{{prompt}}")}\n        conversationId: ${q(conversationId)}\n        runtimeMode: fast\n        selectedSkillIds: []\n        ${config.restrictedMode ? "experienceMode: mini_trial" : "experienceMode: security_redteam"}\n`;
  try {
    await writeFile(providerPath, providerYaml, { mode: 0o600 });
    await chmod(providerPath, 0o600);
    const model = await modelConfig();
    if (!model.apiKey || !model.baseUrl || !model.model) throw new Error("AI-Infra-Guard evaluator model is not configured");
    const args = ["--agent_provider", providerPath, "--language", "zh", "--output", reportPath, "--base_url", model.baseUrl, "--model", model.model];
    if (config.skills) args.push("--skills", config.skills);
    await execFileAsync(scanner, args, {
      timeout: Number(process.env.EA_AGENT_REDTEAM_TIMEOUT_MS || 3_600_000),
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, LLM_API_KEY: model.apiKey },
    });
    const raw = await readFile(reportPath);
    await chmod(reportPath, 0o600);
    const report = JSON.parse(raw.toString("utf8"));
    const summary = summarize(report);
    const verdict = summary.high > 0 ? "risk" : summary.medium + summary.low > 0 ? "review" : "pass";
    saveSecurityAssessment({ key: "agent_redteam", provider: "Tencent AI-Infra-Guard / aig-agent-scan", status: "completed", verdict, targetId: adoptId, targetLabel, isolated: true, configFingerprint, toolVersion: "0.1.0", summary, reportFingerprint: hash(raw), reportPath: path.relative(APP_ROOT, reportPath), requestedAt, completedAt: new Date().toISOString() });
    console.log(JSON.stringify({ ok: true, verdict, summary, configFingerprint, reportPath }, null, 2));
  } catch (error) {
    saveSecurityAssessment({ key: "agent_redteam", provider: "Tencent AI-Infra-Guard / aig-agent-scan", status: "failed", verdict: "error", targetId: adoptId, targetLabel, isolated: true, configFingerprint, errorCode: error instanceof Error ? error.message.slice(0, 300) : "UNKNOWN", requestedAt, completedAt: new Date().toISOString() });
    throw error;
  } finally {
    await rm(providerPath, { force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
