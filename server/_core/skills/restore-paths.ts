import path from "path";

export type RestorePathMap = { from: string; to: string };

export function parseRestorePathMaps(args: string[]): RestorePathMap[] {
  return args
    .filter((arg) => arg.startsWith("--path-map="))
    .map((arg) => {
      const value = arg.slice("--path-map=".length);
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`invalid restore path mapping: ${arg}`);
      }
      const from = path.resolve(value.slice(0, separator));
      const to = path.resolve(value.slice(separator + 1));
      if (from === path.parse(from).root) throw new Error("restore path mapping cannot replace the filesystem root");
      return { from, to };
    });
}

export function remapRestoredPath(rawPath: string | undefined, mappings: RestorePathMap[]): string | undefined {
  const value = String(rawPath || "").trim();
  if (!value || !path.isAbsolute(value)) return rawPath;
  const resolved = path.resolve(value);
  for (const mapping of mappings) {
    if (resolved === mapping.from) return mapping.to;
    if (resolved.startsWith(`${mapping.from}${path.sep}`)) {
      return path.join(mapping.to, path.relative(mapping.from, resolved));
    }
  }
  return rawPath;
}
