import { chmodSync, existsSync, lstatSync, readdirSync } from "fs";
import path from "path";

// Keep Docker/shared deployment compatibility while removing world access.
process.umask(0o027);

function chmodIfPresent(target: string, mode: number) {
  try { if (existsSync(target)) chmodSync(target, mode); } catch {}
}

function hardenTree(root: string) {
  if (!existsSync(root)) return;
  chmodIfPresent(root, 0o750);
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return; }
  for (const name of entries) {
    const target = path.join(root, name);
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) hardenTree(target);
      else chmodIfPresent(target, 0o640);
    } catch {}
  }
}

export function hardenRuntimePermissions(appRoot = process.env.APP_ROOT || process.cwd()) {
  chmodIfPresent(path.join(appRoot, "data"), 0o750);
  hardenTree(path.join(appRoot, "data", "feishu-accounts"));
  hardenTree(path.join(appRoot, "data", "feishu-bridge"));
  hardenTree(path.join(appRoot, "logs"));
  chmodIfPresent(path.join(appRoot, ".env"), 0o600);
  try {
    for (const name of readdirSync(appRoot)) {
      if (name.startsWith(".env.bak")) chmodIfPresent(path.join(appRoot, name), 0o600);
    }
  } catch {}
}

hardenRuntimePermissions();
