import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { APP_ROOT } from "../helpers";

type RoleSkillPreferenceEntry = {
  disabledDefaultSkillIds: string[];
  updatedAt: string;
};

type RoleSkillPreferenceStore = {
  version: 1;
  agents: Record<string, RoleSkillPreferenceEntry>;
};

function normalizeIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).sort();
}

export class FileRoleSkillPreferences {
  constructor(
    private readonly filePath = process.env.ROLE_SKILL_PREFERENCES_PATH
      || path.join(APP_ROOT, "data", "role-skill-preferences.json"),
  ) {}

  private load(): RoleSkillPreferenceStore {
    try {
      if (!existsSync(this.filePath)) return { version: 1, agents: {} };
      const parsed = JSON.parse(String(readFileSync(this.filePath, "utf8") || "{}"));
      const agents = parsed?.agents && typeof parsed.agents === "object" ? parsed.agents : {};
      return { version: 1, agents };
    } catch {
      return { version: 1, agents: {} };
    }
  }

  private save(store: RoleSkillPreferenceStore): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.filePath);
  }

  getDisabledDefaultSkillIds(adoptId: string): string[] {
    const key = String(adoptId || "").trim();
    if (!key) return [];
    return normalizeIds(this.load().agents[key]?.disabledDefaultSkillIds);
  }

  setDefaultSkillEnabled(adoptId: string, skillId: string, enabled: boolean): string[] {
    const key = String(adoptId || "").trim();
    const id = String(skillId || "").trim();
    if (!key || !id) return this.getDisabledDefaultSkillIds(key);

    const store = this.load();
    const disabled = new Set(normalizeIds(store.agents[key]?.disabledDefaultSkillIds));
    if (enabled) disabled.delete(id);
    else disabled.add(id);

    if (disabled.size === 0) {
      delete store.agents[key];
    } else {
      store.agents[key] = {
        disabledDefaultSkillIds: Array.from(disabled).sort(),
        updatedAt: new Date().toISOString(),
      };
    }
    this.save(store);
    return Array.from(disabled).sort();
  }

  clear(adoptId: string): void {
    const key = String(adoptId || "").trim();
    if (!key) return;
    const store = this.load();
    if (!store.agents[key]) return;
    delete store.agents[key];
    this.save(store);
  }
}

export const roleSkillPreferences = new FileRoleSkillPreferences();
