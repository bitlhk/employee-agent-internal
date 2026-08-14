import { access, readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageManager = String(packageJson.packageManager || "");
const managerMatch = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.[A-Za-z0-9+/=]+$/.exec(packageManager);

const violations = [];
if (!managerMatch) {
  violations.push("packageManager must pin pnpm with an integrity hash");
}

const pnpmVersion = managerMatch?.[1] || "";
const pinnedFiles = [
  ["Dockerfile", `pnpm@${pnpmVersion}`],
  ["scripts/bootstrap-install.sh", `pnpm@${pnpmVersion}`],
];
for (const [file, expected] of pinnedFiles) {
  const content = await readFile(file, "utf8");
  if (!pnpmVersion || !content.includes(expected)) {
    violations.push(`${file} must use pnpm ${pnpmVersion || "<packageManager version>"}`);
  }
}

const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
if (!ciWorkflow.includes("uses: pnpm/action-setup@v4")) {
  violations.push(".github/workflows/ci.yml must install pnpm from packageManager through pnpm/action-setup@v4");
}
const pnpmSetupBlock = ciWorkflow.match(/- name: Setup pnpm[\s\S]*?(?=\n\s{6}- name:|$)/)?.[0] || "";
if (/\n\s+version:/.test(pnpmSetupBlock)) {
  violations.push(".github/workflows/ci.yml must not duplicate the packageManager pnpm version");
}

const frozenInstallFiles = [
  ".github/workflows/ci.yml",
  "Dockerfile",
  "scripts/deploy-release.sh",
];
for (const file of frozenInstallFiles) {
  const content = await readFile(file, "utf8");
  if (!content.includes("pnpm install --frozen-lockfile")) {
    violations.push(`${file} must install with --frozen-lockfile`);
  }
}

const forbiddenSource = /^(?:git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|https?:|file:|link:)/i;
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const [name, specifier] of Object.entries(packageJson[section] || {})) {
    const value = String(specifier);
    if (value === "*" || value === "latest" || forbiddenSource.test(value)) {
      violations.push(`${section}.${name} uses mutable or non-registry source ${value}`);
    }
  }
}

for (const alternateLock of ["package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
  try {
    await access(alternateLock);
    violations.push(`remove alternate lockfile ${alternateLock}; pnpm-lock.yaml is authoritative`);
  } catch {}
}

const lockfile = await readFile("pnpm-lock.yaml", "utf8");
if (!lockfile.startsWith("lockfileVersion: '9.0'")) {
  violations.push("pnpm-lock.yaml must use the expected lockfileVersion 9.0");
}

if (violations.length > 0) {
  console.error(`Dependency policy failed:\n${violations.join("\n")}`);
  process.exitCode = 1;
} else {
  const productionCount = Object.keys(packageJson.dependencies || {}).length;
  const developmentCount = Object.keys(packageJson.devDependencies || {}).length;
  console.log(
    `Dependency policy passed: pnpm ${pnpmVersion}, ${productionCount} production and ${developmentCount} development dependencies`,
  );
}
