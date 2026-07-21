import { describe, expect, it } from "vitest";

import { agentArtifactPreviewKind } from "./AgentArtifactPanel";

describe("Agent artifact preview", () => {
  it("selects a renderer from generic MIME types", () => {
    expect(agentArtifactPreviewKind({ name: "preview.png", mimeType: "image/png" })).toBe("image");
    expect(agentArtifactPreviewKind({ name: "architecture.svg", mimeType: "image/svg+xml" })).toBe("image");
    expect(agentArtifactPreviewKind({ name: "report.pdf", mimeType: "application/pdf" })).toBe("pdf");
    expect(agentArtifactPreviewKind({ name: "notes.md", mimeType: "text/markdown" })).toBe("markdown");
    expect(agentArtifactPreviewKind({ name: "recording.mp3", mimeType: "audio/mpeg" })).toBe("audio");
    expect(agentArtifactPreviewKind({ name: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })).toBe("none");
  });
});
