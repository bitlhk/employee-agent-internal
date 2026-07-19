type PublicBaseUrlEnv = Record<string, string | undefined>;

export function resolvePublicBaseUrl(
  env: PublicBaseUrlEnv = process.env,
  fallback = "http://localhost:5180",
): string {
  const value = [
    env.WORKFORCE_AGENT_PUBLIC_BASE_URL,
    env.LINGXIA_PUBLIC_BASE_URL,
    env.PUBLIC_BASE_URL,
    env.FRONTEND_URL,
  ].map((candidate) => String(candidate || "").trim()).find(Boolean) || fallback;
  return value.replace(/\/+$/, "");
}
