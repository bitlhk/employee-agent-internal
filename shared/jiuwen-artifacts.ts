// Workspace runtime state is not a user deliverable. Match only reserved root
// locations: output/SOUL.md and other explicitly exported copies remain valid.
const INTERNAL_WORKSPACE_ROOTS = new Set([
  "context",
  "skills",
  "memory",
  "coding_memory",
  "todo",
  "messages",
  "agents",
  "prompt_attachment",
  "node_modules",
  ".git",
  ".dreams",
  ".openclaw",
  ".agent_history",
]);
const INTERNAL_WORKSPACE_FILES = new Set([
  "agent.md",
  "agents.md",
  "soul.md",
  "heartbeat.md",
  "identity.md",
  "user.md",
  "memory.md",
  "tools.md",
  "bootstrap.md",
  ".workspace",
  ".linggan-role-scope.json",
  ".linggan-managed-skills.json",
]);
const SHELL_REDIRECTION_VERSION_FILE = /^=[0-9]+(?:\.[0-9A-Za-z_+-]+)+$/;

export function isUserVisibleJiuwenArtifactPath(value: unknown): boolean {
  const rel = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const parts = rel.split("/").filter(Boolean);
  const root = (parts[0] || "").toLowerCase();
  const name = parts.at(-1) || "";
  return Boolean(
    parts.length &&
      !parts.some(part => part === "." || part === "..") &&
      !INTERNAL_WORKSPACE_ROOTS.has(root) &&
      !(parts.length === 1 && INTERNAL_WORKSPACE_FILES.has(root)) &&
      !SHELL_REDIRECTION_VERSION_FILE.test(name)
  );
}
