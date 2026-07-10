import { existsSync, lstatSync, mkdirSync, realpathSync } from "fs";
import path from "path";

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function lexicalWorkspacePath(workspace: string, relPath: string): string | null {
  if (!relPath) return path.resolve(workspace);
  if (path.isAbsolute(relPath) || relPath.includes("\0") || relPath.split(/[\\/]+/).includes("..")) return null;
  const root = path.resolve(workspace);
  const candidate = path.resolve(root, relPath);
  return isWithin(candidate, root) ? candidate : null;
}

export function resolveExistingWorkspacePath(
  workspace: string,
  relPath: string,
  allowedExternalRoots: string[] = [],
): string | null {
  const candidate = lexicalWorkspacePath(workspace, relPath);
  if (!candidate || !existsSync(candidate)) return null;
  try {
    const real = realpathSync(candidate);
    const roots = [workspace, ...allowedExternalRoots]
      .filter((root) => existsSync(root))
      .map((root) => realpathSync(root));
    return roots.some((root) => isWithin(real, root)) ? real : null;
  } catch {
    return null;
  }
}

export function resolveWorkspaceWritePath(workspace: string, relPath: string): string | null {
  const candidate = lexicalWorkspacePath(workspace, relPath);
  if (!candidate) return null;
  try {
    mkdirSync(workspace, { recursive: true });
    const realWorkspace = realpathSync(workspace);
    mkdirSync(path.dirname(candidate), { recursive: true });
    const realParent = realpathSync(path.dirname(candidate));
    if (!isWithin(realParent, realWorkspace)) return null;
    if (existsSync(candidate)) {
      if (lstatSync(candidate).isSymbolicLink()) return null;
      const realCandidate = realpathSync(candidate);
      if (!isWithin(realCandidate, realWorkspace)) return null;
    }
    return path.join(realParent, path.basename(candidate));
  } catch {
    return null;
  }
}

export function resolveWorkspaceDeletePath(workspace: string, relPath: string): string | null {
  const candidate = lexicalWorkspacePath(workspace, relPath);
  if (!candidate || !existsSync(candidate)) return null;
  try {
    const realWorkspace = realpathSync(workspace);
    const realParent = realpathSync(path.dirname(candidate));
    return isWithin(realParent, realWorkspace) ? candidate : null;
  } catch {
    return null;
  }
}
