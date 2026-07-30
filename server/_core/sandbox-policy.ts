export type SandboxContainerIdentity = { uid: number; gid: number; value: string };

export type SandboxDockerRunOptions = {
  containerName: string;
  identity: SandboxContainerIdentity;
  image: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  tmpfsSize: string;
  env?: Record<string, string>;
  outputMount?: string;
};

const BLOCKED_PATTERNS = [
  /\bsudo\b/,
  /\bsu\b\s/,
  /\bchmod\b.*[+]s/,
  /\/proc\/sysrq/,
  /\/dev\/sd/,
  /\bdd\b.*\/dev\//,
  /\bnsenter\b/,
  /\bunshare\b/,
  /\bmount\b/,
];

export function resolveSandboxContainerIdentity(
  configured = process.env.SANDBOX_USER,
  hostUid = typeof process.getuid === "function" ? process.getuid() : 0,
  hostGid = typeof process.getgid === "function" ? process.getgid() : 0,
): SandboxContainerIdentity {
  const fallbackUid = hostUid > 0 ? hostUid : 65534;
  const fallbackGid = hostGid > 0 ? hostGid : 65534;
  const match = String(configured || "").trim().match(/^(\d+)(?::(\d+))?$/);
  const requestedUid = match ? Number(match[1]) : fallbackUid;
  const requestedGid = match ? Number(match[2] || match[1]) : fallbackGid;
  const uid = Number.isSafeInteger(requestedUid) && requestedUid > 0 ? requestedUid : fallbackUid;
  const gid = Number.isSafeInteger(requestedGid) && requestedGid > 0 ? requestedGid : fallbackGid;
  return { uid, gid, value: `${uid}:${gid}` };
}

export function sandboxCommandBlockReason(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) return `blocked pattern: ${pattern}`;
  }
  return null;
}

export function buildSandboxDockerRunArgs(options: SandboxDockerRunOptions): string[] {
  const args = [
    "run",
    "--rm",
    "--detach",
    `--name=${options.containerName}`,
    "--network=none",
    "--read-only",
    `--tmpfs=/tmp:size=${options.tmpfsSize}`,
    `--memory=${options.memory}`,
    `--cpus=${options.cpus}`,
    `--pids-limit=${options.pidsLimit}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--user=${options.identity.value}`,
    "--env=HOME=/tmp",
  ];

  for (const [key, value] of Object.entries(options.env || {})) {
    if (/^[A-Z_][A-Z0-9_]*$/i.test(key)) args.push(`--env=${key}=${value}`);
  }
  if (options.outputMount) args.push("-v", `${options.outputMount}:/output`);
  args.push(options.image, "sh", "-c", "sleep 30");
  return args;
}
