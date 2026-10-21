import { conversationConfirmation } from "./confirmation-receipt";
import { cascadeInputSchema } from "../../../shared/scheduling-cascade";
import { listCascades } from "../../db/calendar-cascades";
import { prepareCascade, publicCascade } from "./cascade-service";
export const CASCADE_PLATFORM_TOOLS = [
  {
    name: "prepare_schedule_cascade",
    description:
      "Prepare an immutable dependent rescheduling plan for meetings organized by the current owner only. Each step is one existing meeting, its new event and dependency keys. Dependencies on another included meeting's old slot are inferred. Cycles and conflicting destinations require a new proposal. Returns a whole-plan confirmation page; no calendar write occurs before owner confirmation. Do not include other people's private meetings or claim adjustments are done. Reuse requestKey only for retries.",
    inputSchema: {
      type: "object",
      properties: {
        requestKey: { type: "string", format: "uuid" },
        title: { type: "string" },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              meetingId: { type: "string", format: "uuid" },
              event: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  location: { type: "string" },
                  time: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["timed"] },
                      start: { type: "string" },
                      end: { type: "string" },
                    },
                    required: ["type", "start", "end"],
                    additionalProperties: false,
                  },
                },
                required: ["title", "time"],
                additionalProperties: false,
              },
              dependsOn: { type: "array", items: { type: "string" } },
            },
            required: ["key", "meetingId", "event"],
            additionalProperties: false,
          },
        },
      },
      required: ["requestKey", "title", "steps"],
      additionalProperties: false,
    },
  },
  {
    name: "list_schedule_cascades",
    description:
      "List only the current owner's cascade plans, step outcomes and compensation status. Partial completion is not full success; compensation requires a separate owner confirmation and may itself be blocked by newer changes.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;
export async function handleCascadeTool(
  userId: number,
  name: string,
  args: Record<string, unknown>
) {
  const result =
    name === "prepare_schedule_cascade"
      ? conversationConfirmation("cascade", await prepareCascade(userId, cascadeInputSchema.parse(args)))
      : (await listCascades(userId)).map(publicCascade);
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}
