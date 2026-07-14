const UNIX_RUNTIME_WORKSPACE_RE = /\/(?:[^/\s"'`<>\\]+\/)*\.(?:jiuwenswarm|openclaw)(?:\/[^/\s"'`<>\\]+)*?\/(?:jiuwenclaw_workspace|workspace)(?=\/|[\s"'`<>),.;:\]}]|$)/g;
const WINDOWS_RUNTIME_WORKSPACE_RE = /[A-Za-z]:\\(?:[^\\\s"'`<>/]+\\)*\.(?:jiuwenswarm|openclaw)(?:\\[^\\\s"'`<>/]+)*?\\(?:jiuwenclaw_workspace|workspace)(?=\\|[\s"'`<>),.;:\]}]|$)/g;
const UNIX_PRIVATE_RUNTIME_PATH_RE = /\/(?:[^/\s"'`<>\\]+\/)*\.(?:jiuwenswarm|openclaw)(?:\/[^\s"'`<>\\),;:\]}]*)?/g;
const WINDOWS_PRIVATE_RUNTIME_PATH_RE = /[A-Za-z]:\\(?:[^\\\s"'`<>/]+\\)*\.(?:jiuwenswarm|openclaw)(?:\\[^\s"'`<>/),;:\]}]*)?/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceWorkspacePrefix(text: string, workspaceDir: string): string {
  const candidates = new Set([
    workspaceDir.trim().replace(/[\\/]+$/, ""),
    workspaceDir.trim().replace(/\\/g, "/").replace(/\/+$/, ""),
    workspaceDir.trim().replace(/\//g, "\\").replace(/\\+$/, ""),
  ]);
  let result = text;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const pattern = new RegExp(`${escapeRegExp(candidate)}(?=[\\/]|[\\s"'\`<>),.;:\\]}]|$)`, "g");
    result = result.replace(pattern, "workspace");
  }
  return result;
}

/** Converts private runtime workspace paths into stable user-facing paths. */
export function sanitizePublicRuntimePaths(value: unknown, workspaceDir = ""): string {
  let text = String(value ?? "");
  if (!text) return text;
  if (workspaceDir.trim()) text = replaceWorkspacePrefix(text, workspaceDir);
  return text
    .replace(UNIX_RUNTIME_WORKSPACE_RE, "workspace")
    .replace(WINDOWS_RUNTIME_WORKSPACE_RE, "workspace")
    .replace(UNIX_PRIVATE_RUNTIME_PATH_RE, "[运行时目录]")
    .replace(WINDOWS_PRIVATE_RUNTIME_PATH_RE, "[运行时目录]");
}
