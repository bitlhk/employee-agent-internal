import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Container,
  Database,
  Fingerprint,
  Gauge,
  Layers3,
  Network,
  ScrollText,
  ShieldCheck,
} from "lucide-react";

const graceTerms = [
  { letter: "G", en: "Governance", cn: "治理控制" },
  { letter: "R", en: "Role Identity", cn: "岗位身份" },
  { letter: "A", en: "Agent Runtime", cn: "智能运行" },
  { letter: "C", en: "Context", cn: "企业上下文" },
  { letter: "E", en: "Execution", cn: "受控执行" },
];

const runtimeStages = [
  {
    letter: "R",
    title: "岗位身份",
    en: "Role Identity",
    icon: Fingerprint,
    summary: "明确谁在工作，以及当前岗位实例的授权边界。",
    items: ["用户与岗位实例", "工作区", "权限画像"],
  },
  {
    letter: "C",
    title: "企业上下文",
    en: "Context",
    icon: Database,
    summary: "只装配当前岗位、任务和时间范围内有效的信息。",
    items: ["知识与业务数据", "记忆与任务状态", "能力元数据"],
  },
  {
    letter: "A",
    title: "智能运行",
    en: "Agent Runtime",
    icon: BrainCircuit,
    summary: "由模型、技能和规划协同推进单 Agent 或多 Agent 任务。",
    items: ["模型与技能", "任务规划", "多智能体协作"],
  },
  {
    letter: "E",
    title: "受控执行",
    en: "Execution",
    icon: Network,
    summary: "连接企业能力，把任务转化为可确认、可验证的业务结果。",
    items: ["MCP / API / 工作流", "查询、创建与写回", "结果回执"],
  },
];

const governanceItems = [
  "权限与策略",
  "知识资格",
  "工具与委托治理",
  "人工确认",
  "幂等防重",
  "执行依据",
];

const foundationItems = [
  { name: "审计", en: "Audit", icon: ScrollText },
  { name: "可观测性", en: "Observability", icon: Activity },
  { name: "安全", en: "Security", icon: ShieldCheck },
  { name: "隔离", en: "Isolation", icon: Container },
  { name: "评估", en: "Evaluation", icon: Gauge },
];

export function GraceArchitectureOverview() {
  return (
    <section
      id="grace"
      className="claw-home-grace scroll-mt-16 border-b border-[#e7e4df] bg-[#f7f7f5] px-5 py-16 sm:px-8 sm:py-20"
      aria-labelledby="grace-title"
    >
      <div className="mx-auto max-w-[1120px]">
        <div className="claw-home-grace__heading">
          <div>
            <div className="mb-3 text-xs font-bold text-primary">GRACE 运行框架</div>
            <h2
              id="grace-title"
              className="m-0 max-w-[650px] text-3xl font-bold leading-tight text-[#1a1a1a] sm:text-4xl"
            >
              能把事情办完，也始终在授权边界内
            </h2>
          </div>
          <p>
            每个岗位实例都带着独立身份、企业上下文和可用能力工作。治理控制面贯穿全过程，决定什么能看、什么能做、什么需要确认，并留下可验证的执行依据。
          </p>
        </div>

        <div className="claw-home-grace__identity" aria-label="GRACE 含义">
          <div className="claw-home-grace__wordmark">
            <strong>GRACE</strong>
            <span>Governed Role-based Agent Context &amp; Execution</span>
          </div>
          <div className="claw-home-grace__terms">
            {graceTerms.map(term => (
              <div key={term.letter} className="claw-home-grace__term">
                <span>{term.letter}</span>
                <strong>{term.en}</strong>
                <small>{term.cn}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="claw-home-grace__system">
          <div className="claw-home-grace__control" aria-label="治理控制面">
            <div className="claw-home-grace__control-title">
              <ShieldCheck aria-hidden="true" />
              <span>
                <strong>治理控制面</strong>
                <small>Governance Control Plane</small>
              </span>
            </div>
            <div className="claw-home-grace__control-items">
              {governanceItems.map(item => <span key={item}>{item}</span>)}
            </div>
          </div>

          <div className="claw-home-grace__flow" aria-label="岗位智能体运行链路">
            {runtimeStages.map(stage => (
              <article key={stage.letter} className="claw-home-grace__stage">
                <div className="claw-home-grace__stage-head">
                  <span className="claw-home-grace__stage-icon">
                    <stage.icon aria-hidden="true" />
                  </span>
                  <span>
                    <small>{stage.letter} · {stage.en}</small>
                    <strong>{stage.title}</strong>
                  </span>
                </div>
                <p>{stage.summary}</p>
                <ul>
                  {stage.items.map(item => (
                    <li key={item}>
                      <CheckCircle2 aria-hidden="true" />
                      {item}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <div className="claw-home-grace__foundation" aria-label="平台底座">
            <div className="claw-home-grace__foundation-title">
              <span><Layers3 aria-hidden="true" /></span>
              <span>
                <strong>平台底座</strong>
                <small>Platform Foundation</small>
              </span>
            </div>
            {foundationItems.map(item => (
              <div key={item.name} className="claw-home-grace__foundation-item">
                <item.icon aria-hidden="true" />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.en}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
