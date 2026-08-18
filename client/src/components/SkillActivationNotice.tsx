import { Check, Play, Puzzle, X } from "lucide-react";

export type SkillActivationNoticeValue = {
  skillId: string;
  displayName: string;
  prompt: string;
  warningCount: number;
};

export function SkillActivationNotice({
  value,
  onTry,
  onDismiss,
}: {
  value: SkillActivationNoticeValue;
  onTry: () => void;
  onDismiss: () => void;
}) {
  const steps = [
    "技能包检查",
    value.warningCount > 0 ? `${value.warningCount} 项兼容提示` : "兼容检查",
    "安装完成",
    "企业运行环境已同步",
    "对话已就绪",
  ];

  return (
    <section className="skill-activation-notice" aria-label={`${value.displayName}已就绪`}>
      <div className="skill-activation-notice__title">
        <span><Puzzle aria-hidden="true" /></span>
        <div><strong>{value.displayName}</strong><small>已可在当前岗位智能体中使用</small></div>
      </div>
      <div className="skill-activation-notice__steps">
        {steps.map((step) => <span key={step}><Check aria-hidden="true" />{step}</span>)}
      </div>
      <div className="skill-activation-notice__actions">
        <button type="button" className="is-primary" onClick={onTry}><Play aria-hidden="true" />立即试用</button>
        <button type="button" className="is-icon" onClick={onDismiss} aria-label="关闭技能就绪提示" title="关闭"><X aria-hidden="true" /></button>
      </div>
    </section>
  );
}
