export const EA_ARTIFACT_SCHEMA = "ea.artifact.v1" as const;

export type AgentArtifactRole = "primary" | "preview" | "supporting";

export type AgentTaskArtifact = {
  schema: typeof EA_ARTIFACT_SCHEMA;
  id: string;
  name: string;
  mimeType: string;
  size: number;
  role: AgentArtifactRole;
  path: string;
  sha256?: string;
  previewOf?: string;
};

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function cleanText(value: unknown, maxLength: number): string {
  return String(value || "").trim().slice(0, maxLength);
}
function cleanRelativePath(value: unknown): string {
  const path = cleanText(value, 1024).replace(/\\/g, "/").replace(/^workspace\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return "";
  return path;
}

function normalizeRole(value: unknown): AgentArtifactRole {
  if (value === "preview" || value === "supporting") return value;
  return "primary";
}

export function parseAgentTaskArtifacts(raw: unknown): AgentTaskArtifact[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const artifacts: AgentTaskArtifact[] = [];
  for (const item of value.slice(0, 40)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const path = cleanRelativePath(source.path);
    const name = cleanText(source.name, 255);
    if (!path || !name) continue;
    const rawId = cleanText(source.id, 128);
    const id = SAFE_ID_RE.test(rawId) ? rawId : `artifact-${artifacts.length + 1}`;
    const key = `${id}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const artifact: AgentTaskArtifact = {
      schema: EA_ARTIFACT_SCHEMA,
      id,
      name,
      mimeType: cleanText(source.mimeType, 160) || "application/octet-stream",
      size: Math.max(0, Number(source.size || 0)),
      role: normalizeRole(source.role),
      path,
    };
    const sha256 = cleanText(source.sha256, 64).toLowerCase();
    if (/^[a-f0-9]{64}$/.test(sha256)) artifact.sha256 = sha256;
    const previewOf = cleanText(source.previewOf, 128);
    if (SAFE_ID_RE.test(previewOf)) artifact.previewOf = previewOf;
    artifacts.push(artifact);
  }
  return artifacts;
}
