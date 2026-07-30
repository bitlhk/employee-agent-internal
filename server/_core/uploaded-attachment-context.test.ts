import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_UNTRUSTED_CONTENT_NOTICE,
  buildUploadedAttachmentRuntimeMessage,
  parseUploadedAttachmentRuntimeMessage,
} from "../../shared/uploaded-attachment-context";

describe("uploaded attachment runtime context", () => {
  it("marks attachment contents as untrusted while preserving browser history parsing", () => {
    const runtimeMessage = buildUploadedAttachmentRuntimeMessage("请总结附件", [{
      name: "制度.pdf",
      path: "制度.pdf",
      size: 2048,
    }]);

    expect(runtimeMessage).toContain(ATTACHMENT_UNTRUSTED_CONTENT_NOTICE);
    expect(parseUploadedAttachmentRuntimeMessage(runtimeMessage)).toEqual({
      text: "请总结附件",
      attachments: [{ name: "制度.pdf", path: "制度.pdf", size: 2048 }],
    });
  });

  it("continues to parse historical attachment messages without the safety notice", () => {
    const legacy = [
      "请总结附件",
      "",
      "[已上传附件]",
      "- 制度.pdf (2.0 KB) -> workspace path: 制度.pdf",
      "",
      "需要读取附件内容时，请使用上面的 workspace path。",
    ].join("\n");

    expect(parseUploadedAttachmentRuntimeMessage(legacy).attachments).toHaveLength(1);
  });
});
