import {
  AlertTriangle,
  BarChart3,
  Building2,
  CheckCircle2,
  Database,
  Globe2,
  Layers,
  PhoneCall,
  Plug,
  ShieldCheck,
  UsersRound,
  Wrench,
} from "lucide-react";

export type ConnectorIconInput = {
  serverId: string;
  category?: string;
  source?: string;
  catalogId?: string | null;
};

type ConnectorLogo = { src: string; shape: "square" | "wide" | "natural" };

const CONNECTOR_LOGOS: Record<string, ConnectorLogo> = {
  canva: { src: "/images/connectors/canva-logo.png", shape: "square" },
  feishu: { src: "/images/connectors/feishu-logo.png", shape: "square" },
  github: { src: "/images/connectors/github-logo.png", shape: "square" },
  "google-drive": { src: "/images/connectors/google-drive-logo.png", shape: "natural" },
  hengshengjuyuan: { src: "/images/connectors/hengshengjuyuan-logo.png", shape: "square" },
  jinshuju: { src: "/images/connectors/jinshuju-logo.png", shape: "square" },
  mcdonalds: { src: "/images/connectors/mcdonalds-logo.png", shape: "square" },
  notion: { src: "/images/connectors/notion-logo.png", shape: "square" },
  tianyancha: { src: "/images/connectors/tianyancha-logo.svg", shape: "wide" },
  wind: { src: "/images/connectors/wind-logo.png", shape: "natural" },
  yingmi: { src: "/images/connectors/yingmi-logo.png", shape: "square" },
  yunzhangfang: { src: "/images/connectors/yunzhangfang-logo.png", shape: "natural" },
};

export function connectorLogo(input: ConnectorIconInput): ConnectorLogo | null {
  const catalogId = String(input.catalogId || "").trim().toLowerCase();
  if (CONNECTOR_LOGOS[catalogId]) return CONNECTOR_LOGOS[catalogId];
  const id = String(input.serverId || "").trim().toLowerCase();
  if (id === "platform:feishu" || id.includes("feishu")) return CONNECTOR_LOGOS.feishu;
  if (id.startsWith("wind_") || id === "wind") return CONNECTOR_LOGOS.wind;
  for (const key of ["yingmi", "github", "google-drive", "canva", "notion", "jinshuju", "hengshengjuyuan", "mcdonalds", "yunzhangfang", "tianyancha"]) {
    if (id.includes(key)) return CONNECTOR_LOGOS[key];
  }
  return null;
}

export function ConnectorIcon(input: ConnectorIconInput) {
  const logo = connectorLogo(input);
  if (logo) {
    return (
      <img
        className={`connector-provider-icon connector-provider-icon--${logo.shape}`}
        src={logo.src}
        alt=""
        aria-hidden="true"
      />
    );
  }

  const id = input.serverId.toLowerCase();
  if (input.source === "personal" || id.includes("custom_mcp") || id.includes("custom_user")) return <Plug aria-hidden="true" />;
  if (id.includes("qieman") || id.includes("stock") || id.includes("index")) return <BarChart3 aria-hidden="true" />;
  if (id.includes("bond")) return <Building2 aria-hidden="true" />;
  if (id.includes("credential")) return <CheckCircle2 aria-hidden="true" />;
  if (id.includes("telesales")) return <PhoneCall aria-hidden="true" />;
  if (id.includes("insurance")) return <ShieldCheck aria-hidden="true" />;
  if (id.includes("post_loan") || id.includes("risk")) return <AlertTriangle aria-hidden="true" />;
  if (id.includes("customer")) return <UsersRound aria-hidden="true" />;
  if (id.includes("product")) return <Layers aria-hidden="true" />;
  if (id.includes("platform_tools")) return <Wrench aria-hidden="true" />;
  if (/数据|知识/.test(input.category || "")) return <Database aria-hidden="true" />;
  if (/公共|公开/.test(input.category || "")) return <Globe2 aria-hidden="true" />;
  if (/审核|风控|安全/.test(input.category || "")) return <ShieldCheck aria-hidden="true" />;
  return <Wrench aria-hidden="true" />;
}
