/**
 * WorkforceAgentIcon — 岗位智能体动画 SVG 图标
 * 替代 🦞 emoji，支持 size/animate/idle 动画
 */
import { useEffect, useState } from "react";

type WorkforceAgentIconProps = {
  /** 图标尺寸 px，默认 22 */
  size?: number;
  /** 是否播放入场动画（首次渲染时绘制路径） */
  animate?: boolean;
  /** 是否在 idle 状态下轻微呼吸，默认 true */
  breathe?: boolean;
  /** 自定义 className */
  className?: string;
};

export function WorkforceAgentIcon({
  size = 22,
  animate = true,
  breathe = true,
  className = "",
}: WorkforceAgentIconProps) {
  const [mounted, setMounted] = useState(!animate);
  useEffect(() => {
    if (animate) {
      const t = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(t);
    }
  }, [animate]);

  const uid = `lx-${size}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg"
      className={`workforce-agent-icon ${breathe ? "workforce-agent-icon--breathe" : ""} ${className}`}
      role="img"
      aria-label="岗位智能体"
    >
      <defs>
        <linearGradient id={`${uid}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff5a5f" />
          <stop offset="100%" stopColor="#e11d48" />
        </linearGradient>
      </defs>

      {/* 背景 */}
      <rect
        x="8" y="8" width="112" height="112" rx="24"
        fill="#fff5f5"
        className="workforce-agent-icon__bg"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? "scale(1)" : "scale(0.6)",
          transformOrigin: "64px 64px",
          transition: "opacity 0.3s ease, transform 0.35s cubic-bezier(0.34,1.56,0.64,1)",
        }}
      />

      {/* 身体弧线 */}
      <path
        d="M34 78c0-16 12-28 30-28s30 12 30 28"
        fill="none"
        stroke={`url(#${uid}-g)`}
        strokeWidth="10"
        strokeLinecap="round"
        className="workforce-agent-icon__body"
        style={{
          strokeDasharray: 120,
          strokeDashoffset: mounted ? 0 : 120,
          transition: "stroke-dashoffset 0.6s ease 0.2s",
        }}
      />

      {/* 左眼 */}
      <circle
        cx="50" cy="52" r="6" fill="#111827"
        className="workforce-agent-icon__eye-l"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? "scale(1)" : "scale(0)",
          transformOrigin: "50px 52px",
          transition: "opacity 0.2s ease 0.55s, transform 0.25s cubic-bezier(0.34,1.56,0.64,1) 0.55s",
        }}
      />
      {/* 右眼 */}
      <circle
        cx="78" cy="52" r="6" fill="#111827"
        className="workforce-agent-icon__eye-r"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? "scale(1)" : "scale(0)",
          transformOrigin: "78px 52px",
          transition: "opacity 0.2s ease 0.65s, transform 0.25s cubic-bezier(0.34,1.56,0.64,1) 0.65s",
        }}
      />

      {/* 微笑 */}
      <path
        d="M44 90c6 6 14 9 20 9s14-3 20-9"
        fill="none"
        stroke="#be123c"
        strokeWidth="6"
        strokeLinecap="round"
        className="workforce-agent-icon__smile"
        style={{
          strokeDasharray: 60,
          strokeDashoffset: mounted ? 0 : 60,
          transition: "stroke-dashoffset 0.4s ease 0.75s",
        }}
      />

      {/* 左触角 */}
      <path
        d="M22 38l12 8"
        stroke="#fb7185"
        strokeWidth="6"
        strokeLinecap="round"
        className="workforce-agent-icon__antenna-l"
        style={{
          strokeDasharray: 20,
          strokeDashoffset: mounted ? 0 : 20,
          opacity: mounted ? 1 : 0,
          transition: "stroke-dashoffset 0.3s ease 0.9s, opacity 0.2s ease 0.9s",
        }}
      />
      {/* 右触角 */}
      <path
        d="M106 38l-12 8"
        stroke="#fb7185"
        strokeWidth="6"
        strokeLinecap="round"
        className="workforce-agent-icon__antenna-r"
        style={{
          strokeDasharray: 20,
          strokeDashoffset: mounted ? 0 : 20,
          opacity: mounted ? 1 : 0,
          transition: "stroke-dashoffset 0.3s ease 1.0s, opacity 0.2s ease 1.0s",
        }}
      />
    </svg>
  );
}
