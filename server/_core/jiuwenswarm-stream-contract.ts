import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";
import { validateKnowledgeCitations } from "@shared/knowledge-citations";

export type JiuwenRunDescriptor = {
  runId: string;
  requestId: string;
  sessionId: string;
};

export function buildJiuwenRunDescriptor(args: {
  clientRunId?: string | null;
  requestId: string;
  sessionId: string;
}): JiuwenRunDescriptor {
  const requestId = String(args.requestId || "").trim();
  const sessionId = String(args.sessionId || "").trim();
  return {
    runId: String(args.clientRunId || "").trim() || requestId,
    requestId,
    sessionId,
  };
}

export function buildJiuwenTextDelta(content: string) {
  return {
    __text_mode: "delta" as const,
    choices: [{ delta: { content }, index: 0 }],
  };
}

export function buildJiuwenFinalSnapshot(
  text: string,
  workspaceDir: string,
  allowedKnowledgeIndexes: Iterable<number> = [],
): { __final_text: string } | null {
  const publicText = sanitizePublicRuntimePaths(String(text || ""), workspaceDir);
  const finalText = validateKnowledgeCitations(publicText, allowedKnowledgeIndexes).text;
  return finalText ? { __final_text: finalText } : null;
}
