import { useEffect, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Check, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type RoleAdoptionOption = {
  id: string;
  name: string;
  industry?: string;
  description?: string;
  defaultSkills?: string[];
  mcpServers?: string[];
};

type RoleEffect = "data" | "wealth" | "risk" | "audit" | "protect" | "market";

export type RoleAdoptionVisual = {
  persona: string;
  image: string;
  accent: string;
  soft: string;
  tagline: string;
  greeting: string;
  capabilities: string[];
  effect: RoleEffect;
};

const ROLE_VISUALS: Record<string, RoleAdoptionVisual> = {
  "general-assistant": {
    persona: "灵犀",
    image: "/assets/job-roles/general-assistant.webp",
    accent: "#3b82c4",
    soft: "#eef6fc",
    tagline: "处理日常协作、资料与跨场景任务",
    greeting: "连接知识与工具，帮您高效处理日常工作。",
    capabilities: ["持续对话", "文件处理", "技能扩展"],
    effect: "data",
  },
  "wealth-manager": {
    persona: "知衡",
    image: "/assets/job-roles/wealth-manager.webp",
    accent: "#c33c35",
    soft: "#fff3f0",
    tagline: "洞察客户需求，匹配财富管理方案",
    greeting: "洞察客户需求，为TA匹配最合适的资产配置。",
    capabilities: ["客户画像", "资产配置", "产品推荐"],
    effect: "wealth",
  },
  "post-loan-risk-control": {
    persona: "察微",
    image: "/assets/job-roles/post-loan-risk-control.webp",
    accent: "#168c84",
    soft: "#edf9f7",
    tagline: "持续识别风险，辅助贷后经营决策",
    greeting: "持续识别风险信号，辅助制定稳健的贷后策略。",
    capabilities: ["贷后监测", "风险预警", "风险报告"],
    effect: "risk",
  },
  "credential-compliance": {
    persona: "明鉴",
    image: "/assets/job-roles/credential-compliance.webp",
    accent: "#d24a42",
    soft: "#fff2f0",
    tagline: "识别材料要素，执行专业合规审核",
    greeting: "识别材料关键要素，让每一次审核更准确、更合规。",
    capabilities: ["要素提取", "单证识别", "合规审核"],
    effect: "audit",
  },
  "insurance-advisor": {
    persona: "安护",
    image: "/assets/job-roles/insurance-advisor.webp",
    accent: "#149b8d",
    soft: "#edf9f6",
    tagline: "分析保障需求，支持保险咨询与销售",
    greeting: "理解客户保障需求，协助制定合适的保险方案。",
    capabilities: ["保障规划", "产品推荐", "销售陪练"],
    effect: "protect",
  },
  "investment-researcher": {
    persona: "观澜",
    image: "/assets/job-roles/investment-researcher.webp",
    accent: "#315f9f",
    soft: "#eef3fb",
    tagline: "连接市场数据，完成投研与报价分析",
    greeting: "连接市场与产品数据，辅助完成投研分析与报价。",
    capabilities: ["行情研究", "估值分析", "固收报价"],
    effect: "market",
  },
};

const FALLBACK_VISUAL = ROLE_VISUALS["general-assistant"];

export function roleAdoptionVisual(roleId: string): RoleAdoptionVisual {
  return ROLE_VISUALS[roleId] || FALLBACK_VISUAL;
}

function visualStyle(visual: RoleAdoptionVisual): CSSProperties {
  return {
    "--role-accent": visual.accent,
    "--role-soft": visual.soft,
  } as CSSProperties;
}

function RoleEffectLayer({ effect, active }: { effect: RoleEffect; active: boolean }) {
  return (
    <span className={`role-adoption-effect is-${effect}${active ? " is-active" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function RoleParticles({ active }: { active: boolean }) {
  return (
    <span className={`role-adoption-particles${active ? " is-active" : ""}`} aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => <i key={index} />)}
    </span>
  );
}

function RolePortrait({
  role,
  visual,
  index,
  active,
  provisioning = false,
}: {
  role: RoleAdoptionOption;
  visual: RoleAdoptionVisual;
  index: number;
  active: boolean;
  provisioning?: boolean;
}) {
  const reduceMotion = Boolean(useReducedMotion());
  const animate = reduceMotion
    ? undefined
    : provisioning
      ? { y: [0, -5, 0], scale: [1.02, 1.055, 1.02] }
      : { y: [0, -3, 0], scale: active ? [1.015, 1.035, 1.015] : [1, 1.008, 1] };

  return (
    <span className={`role-adoption-portrait${active ? " is-active" : ""}`}>
      <RoleParticles active={active} />
      <RoleEffectLayer effect={visual.effect} active={active} />
      <motion.img
        src={visual.image}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        animate={animate}
        transition={reduceMotion ? undefined : {
          duration: provisioning ? 1.2 : 3.8 + index * 0.12,
          delay: provisioning ? 0 : index * 0.16,
          ease: "easeInOut",
          repeat: Infinity,
        }}
      />
      {active ? <span className="role-adoption-portrait__pulse" aria-hidden="true" /> : null}
      <span className="sr-only">{role.name}，数字员工{visual.persona}</span>
    </span>
  );
}

export function RoleAdoptionDialog({
  open,
  onOpenChange,
  roles,
  selectedRoleId,
  onSelectRole,
  onAdopt,
  canAdopt = true,
  provisioning,
  provisionStep,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: RoleAdoptionOption[];
  selectedRoleId: string;
  onSelectRole: (roleId: string) => void;
  onAdopt: () => void;
  canAdopt?: boolean;
  provisioning: boolean;
  provisionStep: string;
}) {
  const reduceMotion = Boolean(useReducedMotion());
  const [hoveredRoleId, setHoveredRoleId] = useState<string | null>(null);
  const [greetText, setGreetText] = useState("");
  const selectedRole = roles.find((role) => role.id === selectedRoleId) || null;
  const previewRole = (provisioning ? selectedRole : roles.find((role) => role.id === hoveredRoleId))
    || selectedRole
    || roles[0]
    || null;
  const previewVisual = roleAdoptionVisual(previewRole?.id || "general-assistant");
  const greeting = previewRole
    ? `您好！我是${previewRole.name}智能体 · ${previewVisual.persona}。\n${previewVisual.greeting}`
    : "请选择一位岗位智能体。";
  const [greetingHeadline = "", greetingDetail = ""] = greetText.split("\n");
  const greetingHasDetail = greetText.includes("\n");

  useEffect(() => {
    if (!open) {
      setGreetText("");
      return;
    }

    setGreetText("");
    if (reduceMotion) {
      setGreetText(greeting);
      return;
    }

    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setGreetText(greeting.slice(0, index));
      if (index >= greeting.length) window.clearInterval(timer);
    }, 28);

    return () => window.clearInterval(timer);
  }, [greeting, open, reduceMotion]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (provisioning && !nextOpen) return;
    if (!nextOpen) setHoveredRoleId(null);
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="role-adoption-dialog"
        showCloseButton={!provisioning}
        onEscapeKeyDown={(event) => { if (provisioning) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (provisioning) event.preventDefault(); }}
      >
        <DialogHeader className="role-adoption-dialog__header">
          <DialogTitle className="role-adoption-dialog__title">{canAdopt ? "选择岗位智能体" : "岗位智能体"}</DialogTitle>
          <DialogDescription className="sr-only">
            {canAdopt ? "选择一位数字员工并申请岗位智能体。" : "浏览当前支持的岗位智能体。"}
          </DialogDescription>
        </DialogHeader>

        <div className="role-adoption-dialog__layout">
          <div className="role-adoption-grid" aria-label="岗位列表" onMouseLeave={() => setHoveredRoleId(null)}>
            {roles.map((role, index) => {
              const visual = roleAdoptionVisual(role.id);
              const selected = role.id === selectedRoleId;
              return (
                <motion.button
                  key={role.id}
                  type="button"
                  className={`role-adoption-card${selected ? " is-selected" : ""}`}
                  style={visualStyle(visual)}
                  disabled={provisioning}
                  aria-pressed={selected}
                  aria-label={`${role.name}，数字员工${visual.persona}。${visual.tagline}`}
                  onClick={() => onSelectRole(role.id)}
                  onMouseEnter={() => setHoveredRoleId(role.id)}
                  onFocus={() => setHoveredRoleId(role.id)}
                  initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                  animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                  whileHover={reduceMotion || provisioning ? undefined : { y: -4, scale: 1.012 }}
                  whileTap={reduceMotion || provisioning ? undefined : { scale: 0.985 }}
                  transition={{ duration: 0.22, delay: reduceMotion ? 0 : index * 0.035, ease: "easeOut" }}
                >
                  {selected ? <span className="role-adoption-card__check"><Check /></span> : null}
                  <RolePortrait role={role} visual={visual} index={index} active={selected} provisioning={provisioning && selected} />
                  <span className="role-adoption-card__identity">
                    <strong>{role.name}</strong>
                    <small>{visual.persona}</small>
                  </span>
                  <span className="role-adoption-card__info">
                    <span className="role-adoption-card__tagline">{visual.tagline}</span>
                    <span className="role-adoption-card__tags">
                      {visual.capabilities.map((capability) => <i key={capability}>{capability}</i>)}
                    </span>
                  </span>
                </motion.button>
              );
            })}
          </div>

          <footer className="role-adoption-footer" style={visualStyle(previewVisual)}>
            <div className="role-adoption-footer__selection">
              <span className="role-adoption-footer__icon">
                {previewRole ? <img src={previewVisual.image} alt="" /> : <Sparkles />}
              </span>
              <span className="role-adoption-footer__greeting" aria-label={greeting}>
                <strong aria-hidden="true">
                  {greetingHeadline}
                  {!greetingHasDetail ? <i className="role-adoption-footer__cursor">▍</i> : null}
                </strong>
                <small aria-hidden="true">
                  {greetingDetail}
                  {greetingHasDetail ? <i className="role-adoption-footer__cursor">▍</i> : null}
                </small>
              </span>
            </div>
            {provisioning ? (
              <div className="role-adoption-activation" role="status">
                <span>
                  <strong>正在激活 {selectedRole ? `${selectedRole.name}智能体` : "数字员工"}</strong>
                  <small>{provisionStep || "正在初始化专属实例..."}</small>
                </span>
                <Loader2 className="animate-spin" />
              </div>
            ) : canAdopt ? (
              <Button
                size="lg"
                className="role-adoption-footer__button"
                disabled={!selectedRole || roles.length === 0}
                onClick={onAdopt}
              >
                {selectedRole ? `申请 ${selectedRole.name}` : "请先选择岗位"}
                <ArrowRight />
              </Button>
            ) : (
              <span className="role-adoption-footer__mode">浏览模式</span>
            )}
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
