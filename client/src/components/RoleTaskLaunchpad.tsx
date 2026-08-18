import {
  BarChart3,
  BookOpenCheck,
  BriefcaseBusiness,
  Check,
  FileCheck2,
  FileText,
  Layers3,
  MessageSquareText,
  Puzzle,
  Search,
  ShieldCheck,
  Target,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { RoleHomeRuntimeStatus, RoleHomeTaskStatus } from "@shared/role-home";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import type { ComposerConnector } from "@/lib/composer-connectors";
import { localizedComposerSkillLabel, type ComposerSkillOption } from "@/lib/chat-home-helpers";
import { roleExperience, selectRoleHomeTaskIds, type RoleTaskStarter } from "@/lib/role-experience";

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

const CAPABILITY_ICONS: Record<string, LucideIcon> = {
  customer: UserRound,
  analysis: BarChart3,
  allocation: Layers3,
  product: Search,
  governance: ShieldCheck,
  operations: BriefcaseBusiness,
  research: BookOpenCheck,
  skill: Wrench,
};

function taskAvailability(status: RoleHomeTaskStatus | undefined) {
  if (status?.status === "BLOCKED") return { state: "blocked" as const, label: "暂不可用", reason: status.reason };
  return { state: "available" as const };
}

function featuredTasks(roleTemplate: string, statuses: RoleHomeTaskStatus[]): RoleTaskStarter[] {
  const experience = roleExperience(roleTemplate);
  const taskById = new Map(experience.tasks.map((task) => [task.id, task]));
  return selectRoleHomeTaskIds(roleTemplate, statuses)
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is RoleTaskStarter => Boolean(task));
}

function roleTitle(roleName: string): string {
  const normalized = String(roleName || "岗位").trim();
  return normalized.endsWith("智能体") ? normalized : `${normalized}智能体`;
}

export function RoleTaskLaunchpad({
  roleTemplate,
  roleName,
  skills,
  enterpriseTools,
  selectedSkillIds,
  runtimeStatus,
  onSelectPrompt,
  onSelectSkill,
}: {
  roleTemplate: string;
  roleName: string;
  skills: ComposerSkillOption[];
  enterpriseTools: ComposerConnector[];
  selectedSkillIds: string[];
  runtimeStatus: RoleHomeRuntimeStatus | null;
  onSelectPrompt: (task: RoleTaskStarter) => void;
  onSelectSkill: (skill: ComposerSkillOption) => void;
}) {
  const experience = roleExperience(roleTemplate);
  const statuses = runtimeStatus?.roleTemplate === experience.roleTemplate ? runtimeStatus.tasks : [];
  const statusById = new Map(statuses.map((status) => [status.taskId, status]));
  const tasks = featuredTasks(experience.roleTemplate, statuses);

  return (
    <section className="role-task-launchpad" aria-label={`${roleName}可开始的任务`}>
      <header className="role-task-launchpad__header">
        <div className="role-task-launchpad__identity">
          <h1>{roleTitle(roleName)}</h1>
          <strong>{experience.assistantLabel}</strong>
          <p>{experience.description}</p>
        </div>
      </header>

      <section className="role-task-launchpad__work" aria-labelledby="role-task-launchpad-title">
        <h2 id="role-task-launchpad-title">今天可以开始</h2>
        <div className="role-task-launchpad__tasks">
          {tasks.map((task) => {
            const availability = taskAvailability(statusById.get(task.id));
            const Icon = TASK_ICONS[task.icon];
            return (
              <button
                key={task.id}
                type="button"
                className="role-task-launchpad__task"
                data-state={availability.state}
                disabled={availability.state === "blocked"}
                onClick={() => onSelectPrompt(task)}
                title={availability.reason ? `${task.label}：${availability.reason}` : task.description}
              >
                <span className="role-task-launchpad__task-icon"><Icon aria-hidden="true" /></span>
                <span className="role-task-launchpad__task-copy">
                  <strong>{task.label}</strong>
                  <small>{task.description}</small>
                </span>
                {availability.label ? <span className="role-task-launchpad__task-status">{availability.label}</span> : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="role-task-launchpad__capabilities" aria-labelledby="role-capability-title">
        <div className="role-task-launchpad__section-heading">
          <h2 id="role-capability-title">岗位能力</h2>
        </div>
        <div className="role-task-launchpad__capability-list">
          {experience.capabilities.map((capability) => {
            const Icon = CAPABILITY_ICONS[capability.icon] || Puzzle;
            return (
              <span key={capability.id} className="role-task-launchpad__capability">
                <Icon aria-hidden="true" />
                <strong>{capability.label}</strong>
              </span>
            );
          })}
        </div>
      </section>

      <section className="role-task-launchpad__skills" aria-labelledby="role-skills-title">
        <div className="role-task-launchpad__section-heading">
          <div>
            <h2 id="role-skills-title">岗位技能</h2>
            <span>{skills.length > 0 ? `已启用 ${skills.length} 项` : "暂无已启用技能"}</span>
          </div>
        </div>
        {skills.length > 0 ? (
          <div className="role-task-launchpad__skill-list">
            {skills.map((skill) => {
              const selected = selectedSkillIds.includes(skill.id);
              return (
                <button
                  key={skill.id}
                  type="button"
                  className="role-task-launchpad__skill"
                  data-skill-id={skill.id}
                  data-selected={selected ? "true" : "false"}
                  aria-pressed={selected}
                  title={skill.desc || skill.label}
                  onClick={() => onSelectSkill(skill)}
                >
                  <Puzzle aria-hidden="true" />
                  <strong>{localizedComposerSkillLabel(skill)}</strong>
                  {selected ? <Check className="role-task-launchpad__skill-check" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </section>

      {enterpriseTools.length > 0 ? (
        <section className="role-task-launchpad__enterprise-tools" aria-labelledby="role-enterprise-tools-title">
          <div className="role-task-launchpad__section-heading">
            <div>
              <h2 id="role-enterprise-tools-title">企业工具</h2>
              <span>已连接 {enterpriseTools.length} 项</span>
            </div>
          </div>
          <div className="role-task-launchpad__enterprise-tool-list">
            {enterpriseTools.map((connector) => {
              const toolNames = connector.tools.map((tool) => tool.description || tool.name).filter(Boolean);
              const detail = toolNames.length > 0
                ? `${connector.description}\n可调用：${toolNames.join("、")}`
                : connector.description;
              return (
                <span
                  key={connector.serverId}
                  className="role-task-launchpad__enterprise-tool"
                  title={detail || connector.name}
                >
                  <ConnectorIcon {...connector} />
                  <strong>{connector.name}</strong>
                </span>
              );
            })}
          </div>
        </section>
      ) : null}
    </section>
  );
}
