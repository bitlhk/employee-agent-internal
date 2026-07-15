export type RuntimeModelOption = {
  id: string;
  name?: string | null;
  desc?: string | null;
  provider?: string | null;
  isDefault?: boolean;
  available?: boolean;
  badge?: string | null;
  group?: string | null;
};

export type ModelBrand =
  | "auto"
  | "glm"
  | "pangu"
  | "deepseek"
  | "qwen"
  | "openai"
  | "generic";

export type ModelPresentation = {
  id: string;
  displayName: string;
  brand: ModelBrand;
  iconSrc?: string;
  available: boolean;
};

const BRAND_ICON_SRC: Partial<Record<ModelBrand, string>> = {
  glm: "/images/model-providers/glm.png",
  pangu: "/images/model-providers/pangu.png",
};

function modelToken(option: RuntimeModelOption) {
  const id = String(option.id || "").trim();
  const name = String(option.name || "").trim();
  const raw = name && name !== id ? name : id;
  const parts = raw.split("/").filter(Boolean);
  return (parts.at(-1) || raw).trim();
}

function formatKnownModelName(token: string, brand: ModelBrand) {
  const normalized = token.replaceAll("_", "-");

  if (brand === "auto") return "自动";

  if (brand === "glm") {
    return "GLM";
  }

  if (brand === "pangu") {
    return "openPangu";
  }

  if (brand === "deepseek") {
    return normalized
      .replace(/^deepseek-?/i, "")
      .split("-")
      .filter(Boolean)
      .map(part =>
        part.length <= 2
          ? part.toUpperCase()
          : part[0].toUpperCase() + part.slice(1)
      )
      .reduce((name, part) => `${name} ${part}`, "DeepSeek")
      .trim();
  }

  if (brand === "qwen") {
    return normalized
      .replace(/^qwen-?/i, "")
      .split("-")
      .filter(Boolean)
      .reduce(
        (name, part) => `${name} ${part[0].toUpperCase()}${part.slice(1)}`,
        "Qwen"
      )
      .trim();
  }

  if (brand === "openai") {
    return normalized
      .split("-")
      .filter(Boolean)
      .map(part =>
        /^(gpt|o\d|codex)$/i.test(part) ? part.toUpperCase() : part
      )
      .join(" ");
  }

  return token;
}

function identifyBrand(token: string): ModelBrand {
  const normalized = token.toLowerCase();
  if (normalized.includes("__auto")) return "auto";
  if (normalized.includes("openpangu") || normalized.includes("pangu"))
    return "pangu";
  if (normalized.includes("deepseek")) return "deepseek";
  if (normalized.includes("qwen")) return "qwen";
  if (normalized.includes("glm")) return "glm";
  if (/(^|[-_/])(gpt|o\d|codex)([-_/]|$)/i.test(normalized)) return "openai";
  return "generic";
}

export function presentModel(option: RuntimeModelOption): ModelPresentation {
  const token = modelToken(option);
  const brand = identifyBrand(`${option.id} ${option.name || ""}`);

  return {
    id: option.id,
    displayName: formatKnownModelName(token, brand),
    brand,
    iconSrc: BRAND_ICON_SRC[brand],
    available: option.available !== false,
  };
}
