import React from "react";
import { Check, Sparkles } from "lucide-react";

import type { AgentInteraction } from "@shared/agent-interaction";

export function ExpertInteractionPrompt({
  expertName,
  interaction,
  selectedOptionId,
  disabled = false,
  onSelect,
}: {
  expertName: string;
  interaction: AgentInteraction;
  selectedOptionId: string;
  disabled?: boolean;
  onSelect: (optionId: string) => void;
}) {
  return (
    <section className="expert-interaction" aria-label={`${expertName}需要确认`}>
      <div className="expert-interaction__heading">
        <span className="expert-interaction__eyebrow">
          <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" />
          {expertName}需要确认
        </span>
        <strong>{interaction.title}</strong>
        {interaction.description ? <p>{interaction.description}</p> : null}
      </div>
      <div className="expert-interaction__options" role="radiogroup" aria-label={interaction.title}>
        {interaction.options.map((option) => {
          const selected = option.id === selectedOptionId;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-selected={selected ? "true" : "false"}
              disabled={disabled}
              onClick={() => onSelect(option.id)}
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
              {option.recommended ? <em>推荐</em> : null}
            </button>
          );
        })}
      </div>
      <div className="expert-interaction__hint">
        {interaction.allowCustom ? "也可以直接输入其他方案" : "选择后发送"}
        {interaction.allowNote ? "，输入框内容会作为补充说明" : ""}
      </div>
    </section>
  );
}
