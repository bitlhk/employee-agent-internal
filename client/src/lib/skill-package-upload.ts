export type SkillPackageInspectResponse = {
  skill: {
    skillId: string;
    displayName: string;
    description?: string;
    warnings?: string[];
  };
};

export type SkillPackageUploadResponse = {
  ok: boolean;
  item?: { id?: string };
  warnings?: string[];
};

const SKILL_PACKAGE_REQUEST_TIMEOUT_MS = 90_000;
const SKILL_PACKAGE_RETRYABLE_STATUSES = new Set([429, 503]);

function retryDelayMs(response: Response): number {
  const raw = Number.parseInt(response.headers.get("Retry-After") || "", 10);
  if (!Number.isFinite(raw) || raw < 0) return 1_000;
  return Math.min(raw * 1_000, 5_000);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function postSkillPackage<T>(url: string, file: File, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params);
  const body = await file.arrayBuffer();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), SKILL_PACKAGE_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}?${query.toString()}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/octet-stream" },
        body,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return data as T;
      if (attempt === 0 && SKILL_PACKAGE_RETRYABLE_STATUSES.has(response.status)) {
        await wait(retryDelayMs(response));
        continue;
      }
      throw new Error(data?.message || data?.error || `request failed: ${response.status}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("技能包处理超时，请稍后重试");
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  throw new Error("技能包处理失败，请稍后重试");
}

export async function inspectSkillPackage(file: File, adoptId: string): Promise<SkillPackageInspectResponse> {
  return await postSkillPackage<SkillPackageInspectResponse>("/api/claw/skill-package/inspect", file, {
    adoptId,
    filename: file.name,
  });
}

export async function uploadSkillPackage(input: {
  file: File;
  adoptId: string;
  displayName: string;
  description: string;
}): Promise<SkillPackageUploadResponse> {
  return await postSkillPackage<SkillPackageUploadResponse>("/api/claw/skill-package/upload", input.file, {
    adoptId: input.adoptId,
    filename: input.file.name,
    displayName: input.displayName,
    description: input.description,
  });
}
