import { Bot, ShieldCheck } from "lucide-react";

export const INVESTMENT_TEAM_MEMBERS = [
  { id: "warren_buffett", name: "巴菲特", englishName: "Warren Buffett", image: "/images/experts/investment-team/warren-buffett.png" },
  { id: "ben_graham", name: "格雷厄姆", englishName: "Benjamin Graham", image: "/images/experts/investment-team/benjamin-graham.png" },
  { id: "charlie_munger", name: "芒格", englishName: "Charlie Munger", image: "/images/experts/investment-team/charlie-munger.png" },
  { id: "aswath_damodaran", name: "达摩达兰", englishName: "Aswath Damodaran", image: "/images/experts/investment-team/aswath-damodaran.png" },
  { id: "nassim_taleb", name: "塔勒布", englishName: "Nassim Nicholas Taleb", image: "/images/experts/investment-team/nassim-taleb.png" },
  { id: "stanley_druckenmiller", name: "德鲁肯米勒", englishName: "Stanley Druckenmiller", image: "/images/experts/investment-team/stanley-druckenmiller.png" },
] as const;

export function isInvestmentTeamExpert(agentId: unknown, agentName: unknown) {
  const signature = `${String(agentId || "")} ${String(agentName || "")}`.toLocaleLowerCase();
  return signature.includes("a-share-research-committee")
    || signature.includes("多策略投研团");
}

export function ExpertTeamAvatar() {
  return (
    <span className="expert-team-avatar" aria-hidden="true">
      {INVESTMENT_TEAM_MEMBERS.map((member) => (
        <img key={member.id} src={member.image} alt="" />
      ))}
    </span>
  );
}

export function ExpertTeamRoster({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "expert-team-roster is-compact" : "expert-team-roster"}>
      {INVESTMENT_TEAM_MEMBERS.map((member) => (
        <span className="expert-team-roster__member" key={member.id} title={`${member.name} · ${member.englishName}`}>
          <img src={member.image} alt="" aria-hidden="true" />
          {!compact ? (
            <span>
              <strong>{member.name}</strong>
              <small>{member.englishName}</small>
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

export function ExpertMemberAvatar({ memberId }: { memberId: unknown }) {
  const member = INVESTMENT_TEAM_MEMBERS.find((item) => item.id === String(memberId || ""));
  if (!member) return null;
  return <img className="expert-member-avatar" src={member.image} alt="" aria-hidden="true" />;
}

export function expertVisualKind(agentId: unknown, agentName: unknown) {
  const signature = `${String(agentId || "")} ${String(agentName || "")}`.toLocaleLowerCase();
  if (isInvestmentTeamExpert(agentId, agentName)) return "investment-team";
  if (signature.includes("wind") || signature.includes("万得") || signature.includes("alice")) return "alice";
  if (/ppt|presentation|演示|cyber/.test(signature)) return "presentation";
  if (/diagram|flow|chart|图表|流程|架构|archify/.test(signature)) return "workflow";
  if (/tcm|中医|经方|nihaixia/.test(signature)) return "tcm";
  if (/risk|风控|审核/.test(signature)) return "risk";
  return "generic";
}

export function ExpertAvatar({ agentId, agentName }: { agentId?: unknown; agentName?: unknown }) {
  const kind = expertVisualKind(agentId, agentName);
  if (kind === "investment-team") return <ExpertTeamAvatar />;
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
