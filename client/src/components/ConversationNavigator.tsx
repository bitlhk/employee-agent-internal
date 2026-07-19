import React, { memo, useEffect, useId, useRef, useState } from "react";

export type ConversationNavigatorSource = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: Array<{ name?: string }>;
};

export type ConversationNavigatorItem = {
  id: string;
  label: string;
  fullLabel: string;
};

const ATTACHMENT_ONLY_PROMPTS = new Set([
  "请查看我上传的附件。",
  "请查看我上传的附件",
]);
const MAX_VISIBLE_RAIL_MARKS = 24;

function normalizePromptText(value: string): string {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " 代码片段 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s|\d+[.)]\s)\s*/gm, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function truncatePrompt(value: string, maxLength = 52): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  return `${chars.slice(0, maxLength).join("")}...`;
}

export function buildConversationNavigatorItems(
  messages: ConversationNavigatorSource[],
): ConversationNavigatorItem[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message, index) => {
      const attachmentNames = (message.attachments || [])
        .map((attachment) => String(attachment.name || "").trim())
        .filter(Boolean);
      const normalizedText = normalizePromptText(message.text);
      const textIsAttachmentPlaceholder = ATTACHMENT_ONLY_PROMPTS.has(normalizedText);
      const attachmentLabel = attachmentNames.length > 0
        ? `附件：${attachmentNames[0]}${attachmentNames.length > 1 ? ` 等 ${attachmentNames.length} 个` : ""}`
        : "";
      const fullLabel = (!normalizedText || textIsAttachmentPlaceholder)
        ? attachmentLabel || `第 ${index + 1} 次提问`
        : normalizedText;

      return {
        id: message.id,
        label: truncatePrompt(fullLabel),
        fullLabel,
      };
    });
}

type ConversationNavigatorProps = {
  items: ConversationNavigatorItem[];
  activeId?: string;
  onNavigate: (id: string) => void;
};

function sameItems(
  previous: ConversationNavigatorItem[],
  next: ConversationNavigatorItem[],
): boolean {
  return previous.length === next.length && previous.every((item, index) => (
    item.id === next[index]?.id && item.label === next[index]?.label
  ));
}

export function getVisibleConversationRailItems(
  items: ConversationNavigatorItem[],
  activeId?: string,
  limit = MAX_VISIBLE_RAIL_MARKS,
): ConversationNavigatorItem[] {
  if (items.length <= limit) return items;
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeId));
  const desiredStart = activeIndex - Math.floor(limit / 2);
  const start = Math.min(items.length - limit, Math.max(0, desiredStart));
  return items.slice(start, start + limit);
}

function ConversationNavigatorComponent({
  items,
  activeId,
  onNavigate,
}: ConversationNavigatorProps) {
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (items.length < 2) return null;

  const visibleRailItems = getVisibleConversationRailItems(items, activeId);

  const closeAfterNavigate = () => {
    if (window.matchMedia("(hover: none)").matches) setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="conversation-navigator"
      data-open={open ? "true" : "false"}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="conversation-navigator__trigger"
        aria-label="打开会话提纲"
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="conversation-navigator__rail" aria-hidden="true">
          {visibleRailItems.map((item) => (
            <span
              key={item.id}
              className="conversation-navigator__mark"
              data-active={item.id === activeId ? "true" : "false"}
            />
          ))}
        </span>
      </button>

      <div
        id={panelId}
        className="conversation-navigator__panel"
        role="dialog"
        aria-label="会话提纲"
        aria-hidden={!open}
        inert={!open ? true : undefined}
      >
        <ol className="conversation-navigator__list">
          {items.map((item) => {
            const active = item.id === activeId;
            return (
              <li key={item.id}>
                <button
                  ref={active ? activeItemRef : undefined}
                  type="button"
                  className="conversation-navigator__item"
                  data-active={active ? "true" : "false"}
                  aria-current={active ? "location" : undefined}
                  title={item.fullLabel}
                  onClick={() => {
                    onNavigate(item.id);
                    closeAfterNavigate();
                  }}
                >
                  <span className="conversation-navigator__label">{item.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

export const ConversationNavigator = memo(
  ConversationNavigatorComponent,
  (previous, next) => (
    previous.activeId === next.activeId &&
    previous.onNavigate === next.onNavigate &&
    sameItems(previous.items, next.items)
  ),
);
