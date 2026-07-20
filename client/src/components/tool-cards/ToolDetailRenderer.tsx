import { useState } from "react";
import { classifyToolName, type ToolVisualKind } from "@/lib/tool-presentation";
import { sanitizePublicRuntimePaths } from "@shared/lib/public-runtime-path";

export type ToolDetailEntry = {
  name: string;
  arguments: string;
  result?: string;
  status: "running" | "done" | "error";
};

type ToolDetailLabels = {
  arguments: string;
  result: string;
};

const TOOL_DETAIL_LABELS: Partial<Record<ToolVisualKind, ToolDetailLabels>> = {
  terminal: { arguments: "命令参数", result: "命令输出" },
  mcp: { arguments: "请求参数", result: "返回结果" },
  skill: { arguments: "技能参数", result: "技能结果" },
  file: { arguments: "文件参数", result: "执行结果" },
  database: { arguments: "查询参数", result: "查询结果" },
  web: { arguments: "检索参数", result: "检索结果" },
};

function formatToolArguments(rawArguments: string): string {
  let value = sanitizePublicRuntimePaths(rawArguments);
  try {
    value = JSON.stringify(JSON.parse(value), null, 2);
  } catch {}
  return value;
}

function CopyableToolBlock({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = String(value || "");
  const isLong = text.length > 900 || text.split("\n").length > 14;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  return (
    <div className="lingxia-toolcard__section">
      <div className="lingxia-toolcard__section-head">
        <div className="lingxia-toolcard__label">{label}</div>
        <div className="lingxia-toolcard__section-actions">
          {isLong ? (
            <button type="button" className="lingxia-toolcard__mini-btn" onClick={() => setExpanded((current) => !current)}>
              {expanded ? "收起" : "展开"}
            </button>
          ) : null}
          <button type="button" className="lingxia-toolcard__mini-btn" onClick={copy}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <pre className={`lingxia-toolcard__pre ${danger ? "lingxia-toolcard__pre--danger" : ""}`} data-expanded={expanded ? "true" : "false"}>
        {text || "(无输出)"}
      </pre>
    </div>
  );
}

export function ToolDetailRenderer({ tool }: { tool: ToolDetailEntry }) {
  const kind = classifyToolName(tool.name);
  const labels = TOOL_DETAIL_LABELS[kind] || { arguments: "参数", result: "结果" };
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const argumentsText = formatToolArguments(tool.arguments);

  return (
    <div className="lingxia-toolcard__body" data-tool-kind={kind}>
      {argumentsText ? <CopyableToolBlock label={labels.arguments} value={argumentsText} /> : null}
      {!isRunning ? (
        <CopyableToolBlock
          label={isError ? "错误" : labels.result}
          value={sanitizePublicRuntimePaths(tool.result || "(无输出)")}
          danger={isError}
        />
      ) : null}
    </div>
  );
}
