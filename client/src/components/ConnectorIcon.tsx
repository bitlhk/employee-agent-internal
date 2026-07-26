import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  Database,
  GitBranch,
  Globe2,
  HardDrive,
  Layers,
  LibraryBig,
  MessageSquare,
  Palette,
  PhoneCall,
  Plug,
  ReceiptText,
  ShieldCheck,
  TableProperties,
  UsersRound,
  Utensils,
  WalletCards,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type ConnectorIconInput = {
  serverId: string;
  category?: string;
  source?: string;
  catalogId?: string | null;
};

export type ConnectorIconKind =
  | "alert"
  | "book"
  | "briefcase"
  | "building"
  | "chart"
  | "check"
  | "database"
  | "git"
  | "globe"
  | "hard-drive"
  | "layers"
  | "library"
  | "message"
  | "palette"
  | "phone"
  | "plug"
  | "receipt"
  | "shield"
  | "table"
  | "users"
  | "utensils"
  | "wallet"
  | "wrench";

const CATALOG_ICON_KINDS: Record<string, ConnectorIconKind> = {
  atlassian: "briefcase",
  canva: "palette",
  feishu: "message",
  github: "git",
  "google-drive": "hard-drive",
  hengshengjuyuan: "database",
  jinshuju: "table",
  mcdonalds: "utensils",
  "microsoft-learn": "book",
  notion: "library",
  slack: "users",
  tianyancha: "building",
  tongzhou: "library",
  wind: "chart",
  yingmi: "wallet",
  yunzhangfang: "receipt",
};

const ICONS: Record<ConnectorIconKind, LucideIcon> = {
  alert: AlertTriangle,
  book: BookOpen,
  briefcase: BriefcaseBusiness,
  building: Building2,
  chart: BarChart3,
  check: CheckCircle2,
  database: Database,
  git: GitBranch,
  globe: Globe2,
  "hard-drive": HardDrive,
  layers: Layers,
  library: LibraryBig,
  message: MessageSquare,
  palette: Palette,
  phone: PhoneCall,
  plug: Plug,
  receipt: ReceiptText,
  shield: ShieldCheck,
  table: TableProperties,
  users: UsersRound,
  utensils: Utensils,
  wallet: WalletCards,
  wrench: Wrench,
};

export function connectorIconKind(
  input: ConnectorIconInput
): ConnectorIconKind {
  const catalogId = String(input.catalogId || "")
    .trim()
    .toLowerCase();
  if (CATALOG_ICON_KINDS[catalogId]) return CATALOG_ICON_KINDS[catalogId];

  const id = String(input.serverId || "")
    .trim()
    .toLowerCase();
  if (id === "platform:feishu" || id.includes("feishu")) return "message";
  if (id.startsWith("wind_") || id === "wind") return "chart";
  for (const [key, kind] of Object.entries(CATALOG_ICON_KINDS)) {
    if (id.includes(key)) return kind;
  }
  if (
    input.source === "personal" ||
    id.includes("custom_mcp") ||
    id.includes("custom_user")
  )
    return "plug";
  if (id.includes("qieman") || id.includes("stock") || id.includes("index"))
    return "chart";
  if (id.includes("bond")) return "building";
  if (id.includes("credential")) return "check";
  if (id.includes("telesales")) return "phone";
  if (id.includes("insurance")) return "shield";
  if (id.includes("post_loan") || id.includes("risk")) return "alert";
  if (id.includes("customer")) return "users";
  if (id.includes("product")) return "layers";
  if (id.includes("platform_tools")) return "wrench";
  if (/数据|知识/.test(input.category || "")) return "database";
  if (/公共|公开/.test(input.category || "")) return "globe";
  if (/审核|风控|安全/.test(input.category || "")) return "shield";
  return "wrench";
}

export function ConnectorIcon(input: ConnectorIconInput) {
  const Icon = ICONS[connectorIconKind(input)];
  return <Icon aria-hidden="true" />;
}
