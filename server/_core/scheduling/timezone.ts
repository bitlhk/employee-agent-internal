export function wallInstants(date: string, minute: number, timeZone: string): number[] {
  const wall = Date.parse(date) + minute * 60_000;
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const local = (instant: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(p => [p.type, p.value]));
    return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  };
  const offsets = new Set([-86_400_000, 0, 86_400_000].map(delta => local(wall + delta) - (wall + delta)));
  return [...offsets].map(offset => wall - offset).filter(instant => local(instant) === wall).sort((a, b) => a - b);
}
