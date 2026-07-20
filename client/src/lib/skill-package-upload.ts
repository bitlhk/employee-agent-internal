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

async function postSkillPackage<T>(url: string, file: File, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params);
  const response = await fetch(`${url}?${query.toString()}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/octet-stream" },
    body: await file.arrayBuffer(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `request failed: ${response.status}`);
  return data as T;
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
