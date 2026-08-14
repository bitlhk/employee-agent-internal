import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

const commit = "a".repeat(40);

function runVerifier(apiUrl, requiredChecks = "Lint, typecheck, and test") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "scripts/verify-github-release-checks.mjs",
      "--repository", "bitlhk/employee-agent-internal",
      "--commit", commit,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, RELEASE_GITHUB_API_URL: apiUrl, RELEASE_REQUIRED_GITHUB_CHECKS: requiredChecks },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function withCheckRuns(checkRuns, callback) {
  const server = createServer((req, res) => {
    assert.equal(req.url, `/repos/bitlhk/employee-agent-internal/commits/${commit}/check-runs?filter=latest&per_page=100`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ check_runs: checkRuns }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("accepts a successful required GitHub Actions check", async () => {
  await withCheckRuns([{ name: "Lint, typecheck, and test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }], async (apiUrl) => {
    const result = await runVerifier(apiUrl);
    assert.equal(result.code, 0, result.output);
  });
});

test("rejects a failed required check", async () => {
  await withCheckRuns([{ name: "Lint, typecheck, and test", status: "completed", conclusion: "failure", app: { slug: "github-actions" } }], async (apiUrl) => {
    const result = await runVerifier(apiUrl);
    assert.equal(result.code, 1);
    assert.match(result.output, /not successful/);
  });
});

test("rejects a similarly named check from a non-GitHub Actions app", async () => {
  await withCheckRuns([{ name: "Lint, typecheck, and test", status: "completed", conclusion: "success", app: { slug: "untrusted-app" } }], async (apiUrl) => {
    const result = await runVerifier(apiUrl);
    assert.equal(result.code, 1);
    assert.match(result.output, /not found/);
  });
});
