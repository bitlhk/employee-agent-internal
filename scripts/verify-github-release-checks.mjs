function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function fail(message) {
  console.error(`[RELEASE] CI admission denied: ${message}`);
  process.exit(1);
}

const repository = argument("--repository");
const commit = argument("--commit");
const requiredChecks = String(process.env.RELEASE_REQUIRED_GITHUB_CHECKS || "Lint, typecheck, and test")
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);
const apiBase = String(process.env.RELEASE_GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const token = String(process.env.RELEASE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").trim();

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail("invalid source repository");
if (!/^[0-9a-f]{40}$/i.test(commit)) fail("source commit must be a full Git SHA");
if (requiredChecks.length === 0) fail("at least one required GitHub check must be configured");

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "employee-agent-release-admission",
  "X-GitHub-Api-Version": "2022-11-28",
};
if (token) headers.Authorization = `Bearer ${token}`;

const response = await fetch(
  `${apiBase}/repos/${repository}/commits/${commit}/check-runs?filter=latest&per_page=100`,
  { headers, signal: AbortSignal.timeout(10_000) },
).catch((error) => fail(`GitHub checks request failed: ${error instanceof Error ? error.message : String(error)}`));

if (!response?.ok) {
  fail(`GitHub checks request returned HTTP ${response?.status || "unknown"}`);
}
const payload = await response.json();
const checkRuns = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
for (const requiredName of requiredChecks) {
  const matches = checkRuns.filter((run) => run?.name === requiredName && run?.app?.slug === "github-actions");
  if (matches.length === 0) fail(`required check not found: ${requiredName}`);
  const passed = matches.some((run) => run?.status === "completed" && run?.conclusion === "success");
  if (!passed) {
    const states = matches.map((run) => `${run?.status || "unknown"}/${run?.conclusion || "pending"}`).join(", ");
    fail(`required check is not successful: ${requiredName} (${states})`);
  }
}

console.log(`[RELEASE] CI admission passed for ${repository}@${commit}`);
