import path from "path";

export type RestorePathMap = { from: string; to: string };

// Backups may come from a different OS than the restore host.
function pathFlavor(value: string) {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value)
    ? path.win32
    : value.startsWith("/")
      ? path.posix
      : path;
}

export function parseRestorePathMaps(args: string[]): RestorePathMap[] {
  return args
    .filter(arg => arg.startsWith("--path-map="))
    .map(arg => {
      const value = arg.slice("--path-map=".length);
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`invalid restore path mapping: ${arg}`);
      }
      const source = value.slice(0, separator),
        destination = value.slice(separator + 1);
      const from = pathFlavor(source).resolve(source);
      const to = pathFlavor(destination).resolve(destination);
      if (from === pathFlavor(from).parse(from).root)
        throw new Error(
          "restore path mapping cannot replace the filesystem root"
        );
      return { from, to };
    });
}

export function remapRestoredPath(
  rawPath: string | undefined,
  mappings: RestorePathMap[]
): string | undefined {
  const value = String(rawPath || "").trim();
  const sourcePath = pathFlavor(value);
  if (!value || !sourcePath.isAbsolute(value)) return rawPath;
  const resolved = sourcePath.resolve(value);
  for (const mapping of mappings) {
    if (resolved === mapping.from) return mapping.to;
    if (resolved.startsWith(`${mapping.from}${sourcePath.sep}`)) {
      return pathFlavor(mapping.to).join(
        mapping.to,
        ...sourcePath.relative(mapping.from, resolved).split(sourcePath.sep)
      );
    }
  }
  return rawPath;
}
