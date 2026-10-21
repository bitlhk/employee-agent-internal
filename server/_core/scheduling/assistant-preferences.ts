import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  getClawByAdoptId,
  getCollabSettings,
  upsertCollabSettings,
} from "../../db";
import { collaborationSettingsForTask } from "../../../shared/scheduling-collaboration-policy";
import { recordAuditRequired } from "../audit-events";

export const assistantPreferenceInput = z
  .object({
    adoptId: z.string().min(1),
    acceptTask: z.enum(["off", "approval", "auto"]).optional(),
    sharingPolicy: z.enum(["none", "result-only"]).optional(),
  })
  .strict();
async function ownAssistant(userId: number, adoptId: string) {
  const owner = await getClawByAdoptId(adoptId);
  if (
    !owner ||
    owner.userId !== userId ||
    owner.permissionProfile === "starter" ||
    !["active", "expiring"].includes(owner.status)
  )
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "只能设置本人有协作权限的助手",
    });
  return owner;
}
export async function getSchedulingAssistantPreferences(
  userId: number,
  adoptId: string
) {
  const owner = await ownAssistant(userId, adoptId);
  const settings = collaborationSettingsForTask(
    await getCollabSettings(owner.id),
    "scheduling"
  );
  const acceptTask = settings?.acceptTask || "auto";
  return {
    acceptTask,
    sharingPolicy: settings?.sharingPolicy || "none",
  };
}
export async function saveSchedulingAssistantPreferences(
  userId: number,
  raw: z.infer<typeof assistantPreferenceInput>
) {
  const input = assistantPreferenceInput.parse(raw);
  const owner = await ownAssistant(userId, input.adoptId);
  const patch = {
    ...(input.acceptTask === undefined
      ? {}
      : { schedulingAcceptTask: input.acceptTask }),
    ...(input.sharingPolicy === undefined
      ? {}
      : { schedulingSharingPolicy: input.sharingPolicy }),
  };
  await recordAuditRequired({
    action: "calendar.assistant.policy.changed",
    actorType: "user",
    actorUserId: userId,
    targetType: "claw_adoption",
    targetId: input.adoptId,
    metadata: patch,
  });
  await upsertCollabSettings(owner.id, patch);
  return getSchedulingAssistantPreferences(userId, input.adoptId);
}
