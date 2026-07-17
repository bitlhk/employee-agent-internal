import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

export type JiuwenSessionArtifactFile = {
  name: string;
  size: number;
  path: string;
};

type ArtifactRun = {
  adoptId: string;
  requestId: string;
  updatedAt: string;
  files: JiuwenSessionArtifactFile[];
};

type ArtifactRegistry = {
  version: 1;
  runs: Record<string, ArtifactRun>;
};

const ARTIFACTS_FILE = ".ea-generated-files.json";
const MAX_RUNS = 100;
const MAX_FILES_PER_RUN = 20;
const INTERNAL_WORKSPACE_ROOTS = new Set([
  "context",
  "skills",
  "memory",
  "prompt_attachment",
  "node_modules",
  ".git",
  ".dreams",
  ".openclaw",
  ".agent_history",
]);

function emptyRegistry(): ArtifactRegistry {
  return { version: 1, runs: {} };
}

function safeRequestId(value: unknown): string {
  return String(value || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 180);
}

export function isUserVisibleJiuwenArtifactPath(value: unknown): boolean {
  const rel = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = rel.split("/").filter(Boolean);
  return Boolean(
    parts.length
    && !parts.some((part) => part === "." || part === "..")
    && !INTERNAL_WORKSPACE_ROOTS.has(parts[0]),
  );
}

function normalizeFile(file: JiuwenSessionArtifactFile): JiuwenSessionArtifactFile | null {
  const rel = String(file?.path || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = rel.split("/").filter(Boolean);
  if (!isUserVisibleJiuwenArtifactPath(rel)) return null;
  const normalizedPath = parts.join("/");
  const name = String(file?.name || path.posix.basename(normalizedPath)).trim() || path.posix.basename(normalizedPath);
  return {
    name: name.slice(0, 240),
    size: Math.max(0, Number(file?.size || 0) || 0),
    path: normalizedPath,
  };
}

function readRegistry(filePath: string): ArtifactRegistry {
  try {
    if (!existsSync(filePath)) return emptyRegistry();
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed?.version !== 1 || !parsed?.runs || typeof parsed.runs !== "object") return emptyRegistry();
    return parsed as ArtifactRegistry;
  } catch {
    return emptyRegistry();
  }
}

export function writeJiuwenSessionArtifacts(args: {
  sessionDir: string;
  adoptId: string;
  requestId: string;
  files: JiuwenSessionArtifactFile[];
}): void {
  const requestId = safeRequestId(args.requestId);
  if (!requestId || !args.sessionDir) return;
  const files = Array.from(
    new Map(
      args.files
        .map(normalizeFile)
        .filter((file): file is JiuwenSessionArtifactFile => Boolean(file))
        .map((file) => [file.path, file]),
    ).values(),
  ).slice(0, MAX_FILES_PER_RUN);
  if (!files.length) return;

  mkdirSync(args.sessionDir, { recursive: true, mode: 0o700 });
  const registryPath = path.join(args.sessionDir, ARTIFACTS_FILE);
  const registry = readRegistry(registryPath);
  registry.runs[requestId] = {
    adoptId: String(args.adoptId || "").slice(0, 128),
    requestId,
    updatedAt: new Date().toISOString(),
    files,
  };
  const retained = Object.values(registry.runs)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_RUNS);
  registry.runs = Object.fromEntries(retained.map((run) => [run.requestId, run]));

  const tempPath = `${registryPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, registryPath);
  try { chmodSync(registryPath, 0o600); } catch {}
}

export function readJiuwenSessionArtifacts(historyFile: string): Map<string, ArtifactRun> {
  const registryPath = path.join(path.dirname(historyFile), ARTIFACTS_FILE);
  const registry = readRegistry(registryPath);
  return new Map(Object.values(registry.runs).map((run) => [
    run.requestId,
    {
      ...run,
      files: (Array.isArray(run.files) ? run.files : [])
        .map(normalizeFile)
        .filter((file): file is JiuwenSessionArtifactFile => Boolean(file)),
    },
  ]));
}
