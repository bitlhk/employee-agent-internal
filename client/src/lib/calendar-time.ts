// Calendar wall times are explicitly Beijing time, independent of the device zone.
export const CALENDAR_TIME_ZONE = "Asia/Shanghai";
const offset = 8 * 60 * 60_000;
export function calendarWallDate(value: Date) {
  return new Date(value.getTime() + offset);
}
export function calendarInputValue(value: string) {
  return calendarWallDate(new Date(value)).toISOString().slice(0, 16);
}
export function calendarInputInstant(value: string) {
  return new Date(`${value}+08:00`).toISOString();
}
export function calendarFormat(
  value: string | Date,
  options?: Intl.DateTimeFormatOptions
) {
  return new Date(value).toLocaleString("zh-CN", {
    ...options,
    timeZone: CALENDAR_TIME_ZONE,
  });
}
