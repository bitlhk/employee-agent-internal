import { z } from "zod";
import { personalEventSchema } from "./scheduling";

export const cascadeInputSchema = z
  .object({
    requestKey: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    steps: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
            meetingId: z.string().uuid(),
            event: personalEventSchema,
            dependsOn: z.array(z.string().max(40)).max(12).default([]),
          })
          .strict()
      )
      .min(1)
      .max(12),
  })
  .strict();
export type CascadeInput = z.infer<typeof cascadeInputSchema>;
export type CascadeStep = CascadeInput["steps"][number] & {
  draftId: string;
  previous: z.infer<typeof personalEventSchema>;
  participants?: { userId: number; name: string }[];
  state: "pending" | "waiting" | "completed";
  compensationDraftId?: string;
  compensated?: boolean;
};

export function topologicalSteps<
  T extends { key: string; dependsOn: string[] },
>(steps: T[]): T[] {
  const byKey = new Map(steps.map(step => [step.key, step]));
  if (byKey.size !== steps.length) throw new Error("步骤编号不能重复");
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: T[] = [];
  const visit = (key: string) => {
    if (visiting.has(key))
      throw new Error("调整存在循环依赖，需要另选时间或增加明确的过渡安排");
    if (visited.has(key)) return;
    const step = byKey.get(key);
    if (!step) throw new Error("依赖步骤不存在");
    visiting.add(key);
    step.dependsOn.forEach(visit);
    visiting.delete(key);
    visited.add(key);
    result.push(step);
  };
  steps.forEach(step => visit(step.key));
  return result;
}
