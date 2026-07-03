/**
 * BrandIcon — 品牌图标组件
 *
 * 有自定义 logo 时显示 <img>，默认品牌时显示 Workforce Agent Platform 动画 SVG。
 */

import { useBrand } from "@/lib/useBrand";
import { WorkforceAgentIcon } from "@/components/WorkforceAgentIcon";

const DEFAULT_LOGO = "/images/workforce-agent.svg";

export function BrandIcon({
  size = 26,
  animate = false,
  className = "",
  style,
}: {
  size?: number;
  animate?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const brand = useBrand();
  const isDefault = !brand.logo || brand.logo === DEFAULT_LOGO;

  if (isDefault) {
    return <WorkforceAgentIcon size={size} animate={animate} className={className} />;
  }

  return (
    <img
      src={brand.logo}
      alt={brand.name}
      className={className}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        borderRadius: 4,
        ...style,
      }}
    />
  );
}
