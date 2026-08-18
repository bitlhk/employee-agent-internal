import {
  BarChart3,
  BriefcaseBusiness,
  CheckCircle2,
  FileCheck2,
  FileText,
  MessageSquareText,
  Puzzle,
  Search,
  ShieldCheck,
  Target,
  type LucideIcon,
} from "lucide-react";
import type { ComposerConnector } from "@/lib/composer-connectors";
import { roleExperience, type RoleTaskStarter } from "@/lib/role-experience";

const TASK_ICONS: Record<RoleTaskStarter["icon"], LucideIcon> = {
  brief: BriefcaseBusiness,
  chart: BarChart3,
  check: FileCheck2,
  file: FileText,
  message: MessageSquareText,
  search: Search,
  shield: ShieldCheck,
  target: Target,
};

function connectorReady(connector: ComposerConnector | undefined): boolean {
  return Boolean(
    connector
    && connector.enabledForAgent
    && connector.status === "available"
    && connector.liveStatus !== "unavailable",
  );
}

function taskStatus(task: RoleTaskStarter, connectors: ComposerConnector[], loading: boolean) {
  const required = task.requiredConnectorIds || [];
  if (required.length === 0) return { state: "ready" as const, label: task.attachmentRecommended ? "建议上传材料" : "可开始" };
  if (loading && connectors.length === 0) return { state: "checking" as const, label: "正在核验连接" };
  const missing = required.filter((id) => !connectorReady(connectors.find((connector) => connector.serverId === id)));
  return missing.length === 0
    ? { state: "ready" as const, label: "数据连接可用" }
    : { state: "unavailable" as const, label: "所需连接待恢复" };
}

export function RoleTaskLaunchpad({
  roleTemplate,
  roleName,
  skillCount,
  connectors,
  connectorsLoading,
  onSelectPrompt,
  onOpenSkills,
}: {
  roleTemplate: string;
  roleName: string;
  skillCount: number;
  connectors: ComposerConnector[];
  connectorsLoading: boolean;
  onSelectPrompt: (task: RoleTaskStarter) => void;
  onOpenSkills: () => void;
}) {
  const experience = roleExperience(roleTemplate);
  const readyConnectorCount = connectors.filter(connectorReady).length;
  const maturityLabel = experience.maturity === "reference"
    ? "标杆岗位"
    : experience.maturity === "operational" ? "岗位能力" : "通用能力";

  return (
    <section className="role-task-launchpad" aria-label={`${roleName}可开始的任务`}>
      <header className="role-task-launchpad__header">
        <div>
          <span className="role-task-launchpad__eyebrow">{maturityLabel}</span>
          <h1>{roleName}</h1>
          <p>{experience.summary}</p>
        </div>
        <div className="role-task-launchpad__readiness" aria-label="岗位能力状态">
          <CheckCircle2 aria-hidden="true" />
          <span>{skillCount} 项 Skill</span>
          <i aria-hidden="true" />
          <span>{connectorsLoading && connectors.length === 0 ? "连接核验中" : `${readyConnectorCount} 项企业连接可用`}</span>
        </div>
      </header>

      <div className="role-task-launchpad__tasks">
        {experience.tasks.map((task) => {
          const availability = taskStatus(task, connectors, connectorsLoading);
          const Icon = TASK_ICONS[task.icon];
          return (
            <button
              key={task.id}
              type="button"
              className="role-task-launchpad__task"
              data-state={availability.state}
              disabled={availability.state !== "ready"}
              onClick={() => onSelectPrompt(task)}
              title={availability.state === "unavailable" ? `${task.label}：${availability.label}` : task.description}
            >
              <span className="role-task-launchpad__task-icon"><Icon aria-hidden="true" /></span>
              <span className="role-task-launchpad__task-copy">
                <strong>{task.label}</strong>
                <small>{task.description}</small>
              </span>
              <span className="role-task-launchpad__task-status">{availability.label}</span>
            </button>
          );
        })}
      </div>

      <footer className="role-task-launchpad__footer">
        <span>选择任务后可继续补充客户、企业或材料范围</span>
        <button type="button" onClick={onOpenSkills}><Puzzle aria-hidden="true" />管理 Skill</button>
      </footer>
    </section>
  );
}
