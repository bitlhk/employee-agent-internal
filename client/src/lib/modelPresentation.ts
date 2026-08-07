export type RuntimeModelOption = {
  id: string;
  name?: string | null;
  desc?: string | null;
  provider?: string | null;
  isDefault?: boolean;
  available?: boolean;
  badge?: string | null;
  group?: string | null;
  capabilities?: {
    tools: boolean;
    vision: boolean;
    parallelTools: boolean;
    streaming: boolean;
    contextWindowTokens: number;
    source: "runtime" | "inferred";
  } | null;
};

export type ModelBrand =
  | "auto"
  | "glm"
  | "pangu"
  | "deepseek"
  | "gemma"
  | "nvidia"
  | "poolside"
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
  deepseek: "/images/model-providers/deepseek.svg",
  gemma: "/images/model-providers/gemma.svg",
  glm: "/images/model-providers/glm.png",
  nvidia: "/images/model-providers/nvidia.svg",
  openai: "/images/model-providers/openai.svg",
  pangu: "/images/model-providers/pangu.png",
  poolside: "/images/model-providers/poolside.svg",
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
    const name = normalized.replace(/^glm-?/i, "");
    return name ? `GLM-${name}` : "GLM";
  }

  if (brand === "pangu") {
    const name = normalized.replace(/^openpangu-?/i, "").replace(/^pangu-?/i, "");
    return name ? `openPangu-${name}` : "openPangu";
  }

  if (brand === "deepseek") {
    const name = normalized
      .replace(/^deepseek-?/i, "")
      .split("-")
      .filter(Boolean)
      .map(part =>
        part.length <= 2
          ? part.toUpperCase()
          : part[0].toUpperCase() + part.slice(1)
      )
      .join("-");
    return name ? `DeepSeek-${name}` : "DeepSeek";
  }

  if (brand === "nvidia") {
    if (/^nemotron[ -]nano(?:\s|$)/i.test(token)) return token;
    if (/nemotron/i.test(normalized)) {
      const version = normalized.match(/nemotron-([\d.]+)-nano/i)?.[1];
      return version ? `Nemotron ${version} Nano` : "Nemotron Nano";
    }
    return "NVIDIA";
  }

  if (brand === "openai") {
    const gpt = normalized.match(/^gpt-([\d.]+)(?:[-\s]+(.*))?$/i);
    if (gpt) {
      const suffix = (gpt[2] || "")
        .split(/[-\s]+/)
        .filter(Boolean)
        .map(part => part[0].toUpperCase() + part.slice(1))
        .join(" ");
      return `GPT-${gpt[1]}${suffix ? ` ${suffix}` : ""}`;
    }
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
  if (normalized.includes("gemma")) return "gemma";
  if (normalized.includes("nvidia") || normalized.includes("nemotron"))
    return "nvidia";
  if (normalized.includes("poolside") || normalized.includes("laguna"))
    return "poolside";
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
