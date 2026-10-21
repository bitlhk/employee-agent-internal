import { beforeEach, describe, expect, it, vi } from "vitest";
import { collaborationSettingsForTask } from "../../../shared/scheduling-collaboration-policy";
const store = vi.hoisted(() => ({
  owner: vi.fn(),
  settings: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../db", () => ({
  getClawByAdoptId: store.owner,
  getCollabSettings: store.settings,
  upsertCollabSettings: store.save,
}));
vi.mock("../audit-events", () => ({ recordAuditRequired: vi.fn() }));
import {
  saveSchedulingAssistantPreferences,
  getSchedulingAssistantPreferences,
} from "./assistant-preferences";
beforeEach(() => {
  vi.resetAllMocks();
  store.owner.mockResolvedValue({
    id: 7,
    userId: 42,
    status: "active",
    permissionProfile: "plus",
  });
  store.settings.mockResolvedValue({
    acceptTask: "auto",
    allowedTaskTypes: '["general","custom"]',
    sharingPolicy: "none",
    visibilityMode: "private",
  });
});
describe("scheduling-only assistant preferences", () => {
  it("shows automatic reception for assistants without a saved policy", async () => {
    store.settings.mockResolvedValue(null);
    expect(await getSchedulingAssistantPreferences(42, "own")).toEqual({
      acceptTask: "auto",
      sharingPolicy: "none",
    });
  });
  it("writes only scheduling overrides, retaining general and custom task permissions", async () => {
    await saveSchedulingAssistantPreferences(42, {
      adoptId: "own",
      acceptTask: "auto",
      sharingPolicy: "result-only",
    });
    expect(store.save).toHaveBeenCalledWith(7, {
      schedulingAcceptTask: "auto",
      schedulingSharingPolicy: "result-only",
    });
    expect(await getSchedulingAssistantPreferences(42, "own")).toEqual({
      acceptTask: "auto",
      sharingPolicy: "none",
    });
  });
  it("defaults unconfigured scheduling to automatic reception while preserving explicit choices and other task types", () => {
    const legacy = {
      acceptTask: "auto" as const,
      allowedTaskTypes: "[]",
      sharingPolicy: "result-only" as const,
      visibilityMode: "org",
    };
    expect(collaborationSettingsForTask(legacy, "scheduling")).toMatchObject({
      acceptTask: "auto",
      allowedTaskTypes: '["scheduling"]',
    });
    expect(collaborationSettingsForTask(null, "scheduling")).toMatchObject({
      acceptTask: "auto",
      sharingPolicy: "none",
    });
    expect(
      collaborationSettingsForTask(
        { ...legacy, schedulingAcceptTask: "approval" },
        "scheduling"
      )
    ).toMatchObject({ acceptTask: "approval" });
    const settings = {
      ...legacy,
      schedulingAcceptTask: "off" as const,
      schedulingSharingPolicy: "none" as const,
      schedulingDiscoverable: false,
    };
    expect(collaborationSettingsForTask(settings, "general")).toBe(settings);
    expect(collaborationSettingsForTask(settings, "custom")).toBe(settings);
    expect(collaborationSettingsForTask(settings, "scheduling")).toMatchObject({
      acceptTask: "off",
      allowedTaskTypes: '["scheduling"]',
      sharingPolicy: "none",
      visibilityMode: "private",
    });
  });
  it("rejects other owners, starter assistants, inactive assistants and injected task types", async () => {
    await expect(
      saveSchedulingAssistantPreferences(99, {
        adoptId: "own",
        acceptTask: "auto",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    store.owner.mockResolvedValue({
      userId: 42,
      status: "active",
      permissionProfile: "starter",
    });
    await expect(
      getSchedulingAssistantPreferences(42, "own")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    store.owner.mockResolvedValue({
      userId: 42,
      status: "cancelled",
      permissionProfile: "plus",
    });
    await expect(
      getSchedulingAssistantPreferences(42, "own")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      saveSchedulingAssistantPreferences(42, {
        adoptId: "own",
        allowedTaskTypes: ["general"],
      } as never)
    ).rejects.toThrow();
    expect(store.save).not.toHaveBeenCalled();
  });
});
