import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getCalendarCredentials } from "../../db/scheduling";
import { readOwnCalendar } from "./calendar";
import { availabilityForSlots } from "./availability";
import { recordAuditRequired } from "../audit-events";
import { wallInstants } from "./timezone";
export { wallInstants } from "./timezone";

export const candidateInputSchema = z.object({
  startDate: z.string().date(), endDate: z.string().date(),
  timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
  dayStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  dayEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("18:00"),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  durationMinutes: z.number().int().min(5).max(480),
}).strict().refine(input => Date.parse(input.endDate) >= Date.parse(input.startDate)
  && Date.parse(input.endDate) - Date.parse(input.startDate) < 31 * 86_400_000 && input.dayEnd > input.dayStart, "日期跨度最多31天，工作时间结束必须晚于开始");

// Resolve local wall times against the requested IANA zone. Gaps are skipped; folds retain both instants.

export function generateCandidates(raw: z.input<typeof candidateInputSchema>, now = Date.now()) {
  const input = candidateInputSchema.parse(raw);
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const slots: Array<{ start: string; end: string }> = [];
  for (let day = Date.parse(input.startDate); day <= Date.parse(input.endDate); day += 86_400_000) {
    if (!input.weekdays.includes(new Date(day).getUTCDay())) continue;
    const date = new Date(day).toISOString().slice(0, 10);
    for (let minute = minutes(input.dayStart); minute + input.durationMinutes <= minutes(input.dayEnd); minute += 30) {
      for (const instant of wallInstants(date, minute, input.timeZone)) {
        const end = instant + input.durationMinutes * 60_000;
        if (instant > now && wallInstants(date, minute + input.durationMinutes, input.timeZone).includes(end)) slots.push({ start: new Date(instant).toISOString(), end: new Date(end).toISOString() });
      }
    }
  }
  return slots;
}

export async function recommendOwnCandidates(userId: number, raw: z.input<typeof candidateInputSchema>) {
  const slots = generateCandidates(raw);
  if (!slots.length) return { slots: [], message: "所选范围没有未来候选时间" };
  const credentials = await getCalendarCredentials(userId);
  if (!credentials) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "本人日历未启用" });
  await recordAuditRequired({ action: "calendar.candidates.read", actorType: "agent", actorUserId: userId, targetType: "calendar", targetId: String(userId) });
  const events = await readOwnCalendar(userId, credentials, { start: slots[0].start, end: slots.at(-1)!.end });
  const replies = availabilityForSlots(events, slots, credentials.timeZone);
  // Spread proposals across days before offering multiple times on one day.
  const free = slots.filter((_, i) => replies[i] === "free");
  const selected: typeof slots = []; const days = new Set<string>();
  const zone = candidateInputSchema.parse(raw).timeZone;
  for (const slot of free) {
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: zone }).format(new Date(slot.start));
    if (!days.has(day)) { selected.push(slot); days.add(day); }
    if (selected.length === 6) break;
  }
  for (const slot of free) { if (selected.length >= 6) break; if (!selected.includes(slot)) selected.push(slot); }
  return { slots: selected, message: selected.length ? "根据本人日历推荐；参与人的忙闲需分别协调确认" : "未找到本人已核实的空闲时间，请扩大范围" };
}
