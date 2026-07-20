export const MESSAGE_FEEDBACK_REASON_CODES = [
  "incorrect",
  "incomplete",
  "irrelevant",
  "unclear",
  "tool_failed",
  "too_slow",
  "preference_mismatch",
  "unsafe",
  "other",
] as const;

export type MessageFeedbackReasonCode = typeof MESSAGE_FEEDBACK_REASON_CODES[number];
export type MessageFeedbackRating = "positive" | "negative";

export const MESSAGE_FEEDBACK_REASON_LABELS: Record<MessageFeedbackReasonCode, string> = {
  incorrect: "答案不准确",
  incomplete: "没有解决问题",
  irrelevant: "内容不相关",
  unclear: "表达不清晰",
  tool_failed: "工具调用失败",
  too_slow: "响应太慢",
  preference_mismatch: "不符合我的习惯",
  unsafe: "存在安全或合规顾虑",
  other: "其他",
};
