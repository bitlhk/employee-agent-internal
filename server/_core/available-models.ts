import { inferModelCapabilities, type ModelCapabilities } from "../../shared/model-capabilities";
import { logWarn } from "./observability/logger";
import { automaticModelRoutingEnabled } from "./automatic-model-router";
import {
  JIUWEN_AUTO_MODEL_ID,
  listSelectableJiuwenModels,
  resolveAutomaticSelectableJiuwenModel,
  sanitizeModelAdminError,
} from "./jiuwenswarm-model-admin";

export type RuntimeModelOption = {
  id: string;
  name: string;
  desc?: string;
  isDefault?: boolean;
  capabilities: ModelCapabilities;
};

export async function getAvailableJiuwenModels(): Promise<RuntimeModelOption[]> {
  try {
    const models = await listSelectableJiuwenModels();
    if (models.length > 0) {
      const automaticModel = resolveAutomaticSelectableJiuwenModel(models);
      const orderedModels = automaticModel
        ? [automaticModel, ...models.filter((model) => model.id !== automaticModel.id)]
        : models;
      return [
        {
          id: JIUWEN_AUTO_MODEL_ID,
          name: "自动",
          desc: automaticModelRoutingEnabled() ? "按当前负载自动选择" : automaticModel?.name || "由系统选择",
          isDefault: true,
          capabilities: automaticModel?.capabilities || inferModelCapabilities({ id: "automatic" }),
        },
        ...orderedModels.map((model) => ({
          id: model.id, name: model.name, desc: model.description, isDefault: false, capabilities: model.capabilities,
        })),
      ];
    }
  } catch (error) {
    logWarn("model.catalog.read_failed", { error: sanitizeModelAdminError(error) });
  }
  const id = String(process.env.JIUWENCLAW_DEFAULT_MODEL || "glm-5.2").trim() || "glm-5.2";
  const capabilities = inferModelCapabilities({ id });
  return [
    { id: JIUWEN_AUTO_MODEL_ID, name: "自动", desc: "由系统选择", isDefault: true, capabilities },
    { id, name: id, desc: "JiuwenSwarm", isDefault: false, capabilities },
  ];
}
