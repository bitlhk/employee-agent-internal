export type AdminSkillUploadResult = {
  marketItemId?: number;
  uploadId?: string;
  name: string;
  description?: string;
  version?: string;
  error?: string;
};

export async function uploadSystemSkillPackage(
  file: File
): Promise<AdminSkillUploadResult | null> {
  if (!/\.zip$/i.test(file.name)) {
    throw new Error("请上传 .zip 技能包");
  }
  const version = prompt("发布版本号", "1.0.0")?.trim();
  if (!version) return null;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("版本号必须使用 MAJOR.MINOR.PATCH，例如 1.1.0");
  }
  const changelog = prompt("版本说明", "管理员发布技能版本")?.trim() || "";
  const response = await fetch("/api/claw/skill-market/upload", {
    method: "POST",
    headers: {
      "x-skill-filename": encodeURIComponent(file.name),
      "x-skill-version": version,
      "x-skill-changelog": encodeURIComponent(changelog),
    },
    body: await file.arrayBuffer(),
  });
  const data = (await response.json()) as AdminSkillUploadResult;
  if (!response.ok) throw new Error(data.error || "上传失败");
  return { ...data, version: data.version || version };
}
