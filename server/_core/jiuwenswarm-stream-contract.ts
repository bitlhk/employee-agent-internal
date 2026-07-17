import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";

export function buildJiuwenTextDelta(content: string) {
  return {
    __text_mode: "delta" as const,
    choices: [{ delta: { content }, index: 0 }],
  };
}

export function buildJiuwenFinalSnapshot(text: string, workspaceDir: string): { __final_text: string } | null {
  const finalText = sanitizePublicRuntimePaths(String(text || ""), workspaceDir);
  return finalText ? { __final_text: finalText } : null;
}
