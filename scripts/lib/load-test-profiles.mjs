import { readFile, stat } from "node:fs/promises";
import path from "node:path";

function normalizeProfile(raw, index) {
  const adoptId = String(raw?.adoptId || "").trim();
  const cookie = String(raw?.cookie || "").trim();
  const knowledgeBaseId = String(raw?.knowledgeBaseId || "").trim();
  const selectedSkillId = String(raw?.selectedSkillId || "").trim();
  if (!/^lgj-[A-Za-z0-9_-]{4,64}$/.test(adoptId)) {
    throw new Error(`Load-test profile ${index + 1} has an invalid adoptId`);
  }
  if (!cookie || cookie.length > 16_384) {
    throw new Error(`Load-test profile ${index + 1} has an invalid cookie`);
  }
  if (knowledgeBaseId && !/^kb_[A-Za-z0-9_-]{4,64}$/.test(knowledgeBaseId)) {
    throw new Error(`Load-test profile ${index + 1} has an invalid knowledgeBaseId`);
  }
  if (selectedSkillId && !/^[A-Za-z0-9._-]{1,128}$/.test(selectedSkillId)) {
    throw new Error(`Load-test profile ${index + 1} has an invalid selectedSkillId`);
  }
  return {
    adoptId,
    cookie,
    ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
    ...(selectedSkillId ? { selectedSkillId } : {}),
  };
}

export function normalizeLoadTestProfiles(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Load-test profile file must contain a non-empty JSON array");
  }
  if (raw.length > 200) throw new Error("Load-test profile file cannot contain more than 200 profiles");
  const profiles = raw.map(normalizeProfile);
  const unique = new Set(profiles.map((profile) => profile.adoptId));
  if (unique.size !== profiles.length) throw new Error("Load-test profile adoptIds must be unique");
  return profiles;
}

export async function loadTestProfiles(options = {}) {
  const profileFile = String(options.profileFile || "").trim();
  if (!profileFile) {
    return normalizeLoadTestProfiles([{
      adoptId: options.adoptId,
      cookie: options.cookie,
      knowledgeBaseId: options.knowledgeBaseId,
    }]);
  }

  const resolved = path.resolve(profileFile);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) throw new Error("Load-test profile path must be a regular file");
  if ((fileStat.mode & 0o077) !== 0) {
    throw new Error("Load-test profile file must not be readable or writable by group/others (chmod 600)");
  }
  const payload = JSON.parse(await readFile(resolved, "utf8"));
  return normalizeLoadTestProfiles(payload);
}

export function trpcKnowledgeSearchPath(profile, query = "企业制度与岗位职责", limit = 8) {
  if (!profile.knowledgeBaseId) return "";
  const input = {
    json: {
      adoptId: profile.adoptId,
      knowledgeBaseId: profile.knowledgeBaseId,
      query,
      limit,
    },
  };
  return `/api/trpc/knowledge.search?input=${encodeURIComponent(JSON.stringify(input))}`;
}

export function browserMutationHeaders(cookie, origin = "") {
  const headers = {
    "content-type": "application/json",
    cookie: String(cookie || "").trim(),
    "sec-fetch-site": "same-origin",
  };
  const normalizedOrigin = String(origin || "").trim();
  if (!normalizedOrigin) return headers;
  const parsed = new URL(normalizedOrigin);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("EA_BUSINESS_LOAD_TEST_ORIGIN must use http or https");
  }
  return { ...headers, origin: parsed.origin };
}
