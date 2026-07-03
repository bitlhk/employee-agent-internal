export type SidebarNavItem = {
  key: "skills" | "memory" | "session" | "soul";
  label: string;
};

export const AGENT_SIDEBAR_NAV: SidebarNavItem[] = [
  { key: "skills", label: "技能" },
  { key: "memory", label: "记忆" },
  { key: "session", label: "会话" },
  { key: "soul", label: "设定" },
];

export const LINGXIA_SIDEBAR_NAV = AGENT_SIDEBAR_NAV;
