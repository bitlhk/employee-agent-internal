import type { CalendarEvent } from "../../../../shared/scheduling";
import { useEffect, useRef } from "react";
import { calendarFormat, calendarWallDate } from "@/lib/calendar-time";
import {
  dateKey,
  eventsForDay,
  timedEventLayout,
  type CalendarView,
} from "@/lib/calendar-view";

export function CalendarBoard({
  days,
  events,
  view,
  onSelect,
}: {
  days: Date[];
  events: CalendarEvent[];
  view: CalendarView;
  onSelect: (event: CalendarEvent) => void;
}) {
  const board = useRef<HTMLDivElement>(null);
  const firstDay = dateKey(days[0]);
  useEffect(() => {
    if (board.current) board.current.scrollTop = view === "month" ? 0 : 8 * 64;
  }, [view, firstDay]);
  const today = dateKey(new Date());
  const renderEvent = (event: CalendarEvent) => (
    <button
      type="button"
      key={event.id}
      className={`calendar-event ${event.busy ? "" : "calendar-event--free"}`}
      onClick={() => onSelect(event)}
      title={`${event.title}${event.location ? ` · ${event.location}` : ""}`}
    >
      <span className="calendar-event__time">
        {event.allDay
          ? "全天"
          : calendarFormat(event.start, {
              hour: "2-digit",
              minute: "2-digit",
            })}
      </span>
      <span>{event.title}</span>
    </button>
  );
  return (
    <div
      ref={board}
      className={`calendar-board calendar-board--${view}`}
      aria-label={`${view === "month" ? "月" : view === "week" ? "周" : "日"}日历`}
    >
      {view === "month" && (
        <div className="calendar-month-weekdays">
          {["一", "二", "三", "四", "五", "六", "日"].map(v => (
            <span key={v}>周{v}</span>
          ))}
        </div>
      )}
      <div
        className="calendar-days"
        style={
          view === "month"
            ? {
                gridTemplateRows: `repeat(${Math.ceil((((calendarWallDate(days[0]).getUTCDay() + 6) % 7) + days.length) / 7)}, minmax(0, 1fr))`,
              }
            : { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }
        }
      >
        {view === "month" &&
          Array.from(
            { length: (calendarWallDate(days[0]).getUTCDay() + 6) % 7 },
            (_, i) => (
              <div
                className="calendar-day calendar-day--empty"
                key={`empty-${i}`}
              />
            )
          )}
        {days.map(day => {
          const own = eventsForDay(events, day);
          return (
            <section
              key={dateKey(day)}
              className={`calendar-day ${dateKey(day) === today ? "calendar-day--today" : ""}`}
              aria-label={calendarFormat(day, {
                year: "numeric",
                month: "numeric",
                day: "numeric",
              })}
            >
              <header>
                <span>
                  {view !== "month" &&
                    calendarFormat(day, { weekday: "short" })}
                </span>
                <strong
                  aria-current={dateKey(day) === today ? "date" : undefined}
                >
                  {calendarWallDate(day).getUTCDate()}
                </strong>
              </header>
              {view === "month" ? (
                <div className="calendar-day__events">
                  {own.map(renderEvent)}
                </div>
              ) : (
                <>
                  <div className="calendar-all-day">
                    {own.filter(e => e.allDay).map(renderEvent)}
                  </div>
                  <div className="calendar-timeline">
                    {Array.from({ length: 24 }, (_, hour) => (
                      <div className="calendar-hour" key={hour}>
                        <time>{String(hour).padStart(2, "0")}:00</time>
                      </div>
                    ))}
                    <div className="calendar-timed-events">
                      {timedEventLayout(own, day).map(item => (
                        <div
                          key={item.event.id}
                          className="calendar-event-position"
                          style={{
                            top: (item.from / 60) * 64,
                            height: Math.max(
                              24,
                              ((item.to - item.from) / 60) * 64
                            ),
                            left: `${(item.lane / item.columns) * 100}%`,
                            width: `calc(${100 / item.columns}% - 3px)`,
                          }}
                        >
                          {renderEvent(item.event)}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
