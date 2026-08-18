import {
  BarChart3,
  BookOpenCheck,
  BriefcaseBusiness,
  CheckCircle2,
  CircleAlert,
  Database,
  FileCheck2,
  FileText,
  MessageSquareText,
  Puzzle,
  Search,
  ShieldCheck,
  Target,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { RoleHomeRuntimeStatus, RoleHomeTaskStatus } from "@shared/role-home";
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
  connector: Database,
  knowledge: BookOpenCheck,
  policy: ShieldCheck,
  skill: Wrench,
};

function taskAvailability(task: RoleTaskStarter, status: RoleHomeTaskStatus | undefined, loading: boolean) {
  if (!status) {
    return loading
      ? { state: "checking" as const, label: "正在核验" }
      : { state: "degraded" as const, label: "有限可用", reason: "岗位运行状态暂未完成核验。" };
  }
  if (status.status === "READY") {
    return {
      state: "ready" as const,
      label: task.confirmationRequired ? "可开始 · 执行前确认" : task.attachmentRecommended ? "建议上传材料" : "可开始",
    };
  }
  if (status.status === "DEGRADED") {
    return { state: "degraded" as const, label: "有限可用", reason: status.reason };
  }
  return { state: "blocked" as const, label: "暂不可用", reason: status.reason };
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
  skillCount,
  runtimeStatus,
  connectorsLoading,
  onSelectPrompt,
  onOpenSkills,
}: {
  roleTemplate: string;
  roleName: string;
  skillCount: number;
  runtimeStatus: RoleHomeRuntimeStatus | null;
  connectorsLoading: boolean;
  onSelectPrompt: (task: RoleTaskStarter) => void;
  onOpenSkills: () => void;
}) {
  const experience = roleExperience(roleTemplate);
  const statuses = runtimeStatus?.roleTemplate === experience.roleTemplate ? runtimeStatus.tasks : [];
  const statusById = new Map(statuses.map((status) => [status.taskId, status]));
  const tasks = featuredTasks(experience.roleTemplate, statuses);
  const visibleStatuses = tasks.map((task) => statusById.get(task.id)?.status || (connectorsLoading ? null : "DEGRADED"));
  const readyCount = visibleStatuses.filter((status) => status === "READY").length;
  const degradedCount = visibleStatuses.filter((status) => status === "DEGRADED" || status === null).length;
  const blockedCount = visibleStatuses.filter((status) => status === "BLOCKED").length;
  const maturityLabel = experience.maturity === "reference"
    ? "标杆岗位"
    : experience.maturity === "operational" ? "岗位智能体" : "工作智能体";
  const summary = connectorsLoading && !runtimeStatus
    ? "正在核验岗位能力"
    : [
        readyCount ? `${readyCount} 项任务可开始` : "",
        degradedCount ? `${degradedCount} 项有限可用` : "",
        blockedCount ? `${blockedCount} 项暂不可用` : "",
      ].filter(Boolean).join(" · ");

  return (
    <section className="role-task-launchpad" aria-label={`${roleName}可开始的任务`}>
      <header className="role-task-launchpad__header">
        <div className="role-task-launchpad__identity">
          <span className="role-task-launchpad__eyebrow">{maturityLabel}</span>
          <h1>{roleTitle(roleName)}</h1>
          <strong>{experience.assistantLabel}</strong>
          <p>{experience.description}</p>
        </div>
        <div className="role-task-launchpad__readiness" aria-label="岗位任务状态">
          {blockedCount > 0 ? <CircleAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
          <span>{summary || "岗位能力可用"}</span>
        </div>
      </header>

      <section className="role-task-launchpad__work" aria-labelledby="role-task-launchpad-title">
        <h2 id="role-task-launchpad-title">今天可以开始</h2>
        <div className="role-task-launchpad__tasks">
          {tasks.map((task) => {
            const availability = taskAvailability(task, statusById.get(task.id), connectorsLoading);
            const Icon = TASK_ICONS[task.icon];
            return (
              <button
                key={task.id}
                type="button"
                className="role-task-launchpad__task"
                data-state={availability.state}
                disabled={availability.state === "blocked" || availability.state === "checking"}
                onClick={() => onSelectPrompt(task)}
                title={availability.reason ? `${task.label}：${availability.reason}` : task.description}
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
      </section>

      <section className="role-task-launchpad__capabilities" aria-labelledby="role-capability-title">
        <div className="role-task-launchpad__section-heading">
          <h2 id="role-capability-title">岗位能力</h2>
          <span>企业数据、知识与规则按当前岗位授权</span>
        </div>
        <div className="role-task-launchpad__capability-list">
          {experience.capabilities.map((capability) => {
            const runtimeCapability = runtimeStatus?.capabilities.find((item) => item.id === capability.id);
            const Icon = CAPABILITY_ICONS[capability.kind] || Puzzle;
            const state = runtimeCapability?.status || (connectorsLoading ? "DEGRADED" : "BLOCKED");
            return (
              <span key={capability.id} className="role-task-launchpad__capability" data-state={state.toLowerCase()}>
                <Icon aria-hidden="true" />
                <strong>{capability.label}</strong>
                <small>{runtimeCapability?.statusLabel || (connectorsLoading ? "核验中" : "待核验")}</small>
              </span>
            );
          })}
        </div>
      </section>

      <footer className="role-task-launchpad__footer">
        <span>选择任务后可补充客户、企业或材料范围，也可以直接在下方描述工作。</span>
        <button type="button" onClick={onOpenSkills}><Puzzle aria-hidden="true" />管理 Skill{skillCount > 0 ? ` · ${skillCount}` : ""}</button>
      </footer>
    </section>
  );
}
