import { useBrand } from "@/lib/useBrand";
import type { ReactNode } from "react";

const PAGE_LABELS: Record<string, string> = {
  chat: "聊天",
  skills: "插件中心",
  channels: "频道",
  weixin: "频道",
  agent: "成长记录",
  workspace: "工作空间",
  collab: "协作",
  schedule: "定时任务",
  settings: "设置",
};

type TopBarProps = {
  activePage: string;
  leading?: ReactNode;
  afterPage?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
};

export function TopBar({ activePage, leading, afterPage, center, right }: TopBarProps) {
  const brand = useBrand();
  return (
    <div className="lingxia-topbar">
      <div className="lingxia-topbar__left">
        {leading}
        <span className="lingxia-topbar__brand">{brand.nameEn}</span>
        <span className="lingxia-topbar__sep">›</span>
        <span className="lingxia-topbar__page">{PAGE_LABELS[activePage] || activePage}</span>
        {afterPage}
      </div>
      <div className="lingxia-topbar__center">
        {center}
      </div>
      <div className="lingxia-topbar__right">
        {right}
      </div>
    </div>
  );
}
