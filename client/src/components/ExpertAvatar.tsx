import { Bot, ShieldCheck } from "lucide-react";

export function expertVisualKind(agentId: unknown, agentName: unknown) {
  const signature = `${String(agentId || "")} ${String(agentName || "")}`.toLocaleLowerCase();
  if (signature.includes("wind") || signature.includes("万得") || signature.includes("alice")) return "alice";
  if (/ppt|presentation|演示|cyber/.test(signature)) return "presentation";
  if (/diagram|flow|chart|图表|流程|架构|archify/.test(signature)) return "workflow";
  if (/tcm|中医|经方|nihaixia/.test(signature)) return "tcm";
  if (/risk|风控|审核/.test(signature)) return "risk";
  return "generic";
}

export function ExpertAvatar({ agentId, agentName }: { agentId?: unknown; agentName?: unknown }) {
  const kind = expertVisualKind(agentId, agentName);
  if (kind === "alice") {
    return <img className="expert-avatar-image" src="/images/experts/alice.png" alt="" aria-hidden="true" />;
  }
  if (kind === "presentation") {
    return <img className="expert-avatar-image" src="/images/experts/ppt-expert.jpg" alt="" aria-hidden="true" />;
  }
  if (kind === "workflow") {
    return <img className="expert-avatar-image" src="/images/experts/workflow-expert.png" alt="" aria-hidden="true" />;
  }
  if (kind === "tcm") {
    return <img className="expert-avatar-image" src="/images/experts/zhongyi-expert.png" alt="" aria-hidden="true" />;
  }
  if (kind === "risk") return <ShieldCheck aria-hidden="true" />;
  return <Bot aria-hidden="true" />;
}
