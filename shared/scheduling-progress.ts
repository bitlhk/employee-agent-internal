import { z } from "zod";

export const candidateSlotsSchema = z
  .array(
    z
      .object({
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
      })
      .strict()
      .refine(slot => Date.parse(slot.end) > Date.parse(slot.start))
  )
  .min(1)
  .max(6)
  .refine(
    slots =>
      Math.max(...slots.map(s => Date.parse(s.end))) -
        Math.min(...slots.map(s => Date.parse(s.start))) <=
      31 * 86400000
  );
export type CandidateSlot = z.infer<typeof candidateSlotsSchema>[number];
export type AvailabilityCell =
  | "free"
  | "busy"
  | "pending"
  | "running"
  | "unknown"
  | "unshared"
  | "rejected"
  | "cancelled"
  | "failed"
  | "expired"
  | "unasked";
export type AvailabilityMatrix = {
  people: { id: string; name: string }[];
  rows: (CandidateSlot & { cells: AvailabilityCell[]; common: boolean })[];
};
export const slotKey = (slot: CandidateSlot) =>
  `${Date.parse(slot.start)}:${Date.parse(slot.end)}`;
export function requestedSlots(
  payload: string | null | undefined
): CandidateSlot[] {
  try {
    const parsed = candidateSlotsSchema.safeParse(
      JSON.parse(payload || "{}").slots
    );
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
export function releasedAvailability(summary: string) {
  try {
    return z
      .object({
        availability: z.enum([
          "available",
          "unavailable",
          "conditional",
          "unknown",
        ]),
        slots: candidateSlotsSchema.or(z.array(z.never()).length(0)),
        validUntil: z.string().datetime({ offset: true }),
        observations: z
          .array(
            z.object({
              start: z.string().datetime({ offset: true }),
              end: z.string().datetime({ offset: true }),
              availability: z.enum(["free", "busy", "unknown"]),
            })
          )
          .max(6)
          .optional(),
      })
      .parse(JSON.parse(summary));
  } catch {
    return null;
  }
}
export function availabilityCell(
  status: string,
  shared: boolean,
  summary: string,
  slot: CandidateSlot,
  asked: CandidateSlot[],
  now = Date.now()
): AvailabilityCell {
  const result = releasedAvailability(summary);
  const observation = result?.observations?.find(
    item => slotKey(item) === slotKey(slot)
  );
  const included = result?.slots.some(item => slotKey(item) === slotKey(slot));
  if (
    !asked.some(item => slotKey(item) === slotKey(slot)) &&
    !included &&
    !observation
  )
    return "unasked";
  if (status === "pending") return "pending";
  if (["approved", "running"].includes(status)) return "running";
  if (["rejected", "cancelled", "failed"].includes(status))
    return status as AvailabilityCell;
  if (status !== "completed") return "unknown";
  if (!shared) return "unshared";
  if (!result) return "unknown";
  if (Date.parse(result.validUntil) <= now) return "expired";
  if (observation) return observation.availability;
  // Omitted slots are unknown, never inferred busy from a partial response.
  return included && result.availability === "available" ? "free" : "unknown";
}
