import { Bot, ShieldCheck } from "lucide-react";

export const INVESTMENT_TEAM_MEMBERS = [
  { id: "warren_buffett", name: "巴菲特视角", englishName: "Warren Buffett", summary: "经营质量、现金创造与长期回报", image: "/images/experts/investment-team/warren-buffett.png" },
  { id: "ben_graham", name: "格雷厄姆视角", englishName: "Benjamin Graham", summary: "资产安全、估值折价与下行保护", image: "/images/experts/investment-team/benjamin-graham.png" },
  { id: "charlie_munger", name: "芒格视角", englishName: "Charlie Munger", summary: "商业模式、竞争优势与管理层", image: "/images/experts/investment-team/charlie-munger.png" },
  { id: "aswath_damodaran", name: "达摩达兰视角", englishName: "Aswath Damodaran", summary: "增长假设、资本效率与公司估值", image: "/images/experts/investment-team/aswath-damodaran.png" },
  { id: "nassim_taleb", name: "塔勒布视角", englishName: "Nassim Nicholas Taleb", summary: "杠杆、脆弱性与尾部风险", image: "/images/experts/investment-team/nassim-taleb.png" },
  { id: "stanley_druckenmiller", name: "德鲁肯米勒视角", englishName: "Stanley Druckenmiller", summary: "宏观周期、趋势与盈利修正", image: "/images/experts/investment-team/stanley-druckenmiller.png" },
] as const;

export function investmentTeamMember(memberId: unknown) {
  return INVESTMENT_TEAM_MEMBERS.find((item) => item.id === String(memberId || ""));
}

export function isInvestmentTeamMember(memberId: unknown) {
  return Boolean(investmentTeamMember(memberId));
}

export function isInvestmentTeamExpert(agentId: unknown, agentName: unknown) {
  const signature = `${String(agentId || "")} ${String(agentName || "")}`.toLocaleLowerCase();
  return signature.includes("a-share-research-committee")
    || signature.includes("多策略投研团");
}

export function ExpertTeamAvatar({
  memberIds,
  animated = false,
}: {
  memberIds?: readonly string[];
  animated?: boolean;
} = {}) {
  const requestedMembers = Array.from(new Set(memberIds || []))
    .map((memberId) => investmentTeamMember(memberId))
    .filter((member): member is (typeof INVESTMENT_TEAM_MEMBERS)[number] => Boolean(member));
  const members = requestedMembers.length > 0 ? requestedMembers : INVESTMENT_TEAM_MEMBERS;
  return (
    <span
      className={`expert-team-avatar${animated ? " is-dynamic" : ""}`}
      data-count={members.length}
      aria-hidden="true"
    >
      {members.map((member) => (
        <img key={member.id} src={member.image} alt="" />
      ))}
    </span>
  );
}

export function ExpertTeamRoster({ compact = false, card = false }: { compact?: boolean; card?: boolean }) {
  const className = compact
    ? "expert-team-roster is-compact"
    : card
      ? "expert-team-roster is-card"
      : "expert-team-roster";
  return (
    <span className={className}>
      {INVESTMENT_TEAM_MEMBERS.map((member) => (
        <span className="expert-team-roster__member" key={member.id} title={`${member.name} · ${member.summary}`}>
          <img src={member.image} alt="" aria-hidden="true" />
          {!compact ? (
            <span>
              <strong>{member.name}</strong>
              <small>{member.summary}</small>
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

export function ExpertMemberAvatar({ memberId }: { memberId: unknown }) {
  const member = investmentTeamMember(memberId);
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
