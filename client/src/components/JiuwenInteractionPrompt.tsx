import React from "react";
import { Check, MessageCircleQuestion } from "lucide-react";

import type { JiuwenPermissionRequestCard } from "./ChatMessage";

export function JiuwenInteractionPrompt({
  request,
  selections,
  disabled = false,
  onToggle,
}: {
  request: JiuwenPermissionRequestCard;
  selections: Record<string, string[]>;
  disabled?: boolean;
  onToggle: (questionIndex: number, optionValue: string, multiSelect: boolean) => void;
}) {
  const questions = request.questions?.length
    ? request.questions
    : [{
        header: request.title || "请确认",
        question: request.question,
        options: request.options || [],
        multiSelect: false,
      }];

  return (
    <section className="expert-interaction jiuwen-interaction" aria-label="智能体需要补充信息">
      <div className="expert-interaction__heading">
        <span className="expert-interaction__eyebrow">
          <MessageCircleQuestion size={13} strokeWidth={1.8} aria-hidden="true" />
          继续前请确认
        </span>
      </div>
      {questions.map((question, questionIndex) => {
        const selectedValues = selections[String(questionIndex)] || [];
        return (
          <div className="jiuwen-interaction__question" key={`${question.header}-${questionIndex}`}>
            <div className="jiuwen-interaction__question-heading">
              <strong>{question.question || question.header}</strong>
              {question.multiSelect ? <small>可多选</small> : null}
            </div>
            <div className="expert-interaction__options" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.question || question.header}>
              {question.options.map((option) => {
                const value = option.value || option.label;
                const selected = selectedValues.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    role={question.multiSelect ? "checkbox" : "radio"}
                    aria-checked={selected}
                    data-selected={selected ? "true" : "false"}
                    disabled={disabled}
                    onClick={() => onToggle(questionIndex, value, question.multiSelect)}
                  >
                    <span className="expert-interaction__choice">
                      <span className="expert-interaction__radio" aria-hidden="true">
                        {selected ? <Check size={12} strokeWidth={2.2} /> : null}
                      </span>
                      <span>
                        <b>{option.label}</b>
                        {option.description ? <small>{option.description}</small> : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="expert-interaction__hint">选择完成后发送；选择“其他”时可在输入框补充</div>
    </section>
  );
}
