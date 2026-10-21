import { lazy, Suspense } from "react";
import type { SchedulingConfirmation } from "@/lib/scheduling-confirmations";
import { schedulingTheme } from "@/lib/scheduling-theme";
import "@/styles/scheduling.css";
const WriteDrafts = lazy(() =>
  import("./SchedulingWriteConfirmation").then(module => ({
    default: module.WriteDrafts,
  }))
);
const Meetings = lazy(() =>
  import("./pages/SchedulingMeetings").then(module => ({
    default: module.SchedulingMeetings,
  }))
);
const Cascades = lazy(() =>
  import("./pages/SchedulingCascades").then(module => ({
    default: module.SchedulingCascades,
  }))
);
const Availability = lazy(() =>
  import("./SchedulingAvailabilityActions").then(module => ({
    default: module.SchedulingAvailabilityActions,
  }))
);
const Goal = lazy(() =>
  import("./CollaborationActivity").then(module => ({
    default: module.CollaborationActivity,
  }))
);
const Request = lazy(() =>
  import("./SchedulingRequestAction").then(module => ({
    default: module.SchedulingRequestAction,
  }))
);
export function SchedulingChatConfirmations({
  references,
  onOpenCalendar,
  adoptId,
}: {
  references: SchedulingConfirmation[];
  onOpenCalendar?: () => void;
  adoptId?: string;
}) {
  if (!references.length) return null;
  return (
    <div
      className="scheduling-ui scheduling-chat-confirmations"
      style={schedulingTheme}
      aria-label="本次对话日程确认"
    >
      <Suspense fallback={<p role="status">正在读取待确认安排…</p>}>
        {references.map(reference => (
          <div key={`${reference.kind}:${reference.id}`}>
            {reference.kind === "goal" ? (
              (reference.adoptId || adoptId) ? (
                <Goal adoptId={(reference.adoptId || adoptId)!} focusId={reference.id} onOpenCalendar={onOpenCalendar} />
              ) : null
            ) : reference.kind === "request" ? (
              reference.adoptId ? (
                <Request
                  adoptId={reference.adoptId}
                  requestId={Number(reference.id)}
                />
              ) : null
            ) : ["availability", "coordination"].includes(reference.kind) ? (
              <Availability focusId={reference.id} />
            ) : reference.kind === "draft" ? (
              <WriteDrafts focusId={reference.id} />
            ) : reference.kind === "cascade" ? (
              <Cascades focusId={reference.id} />
            ) : (
              <Meetings focusId={reference.id} />
            )}
          </div>
        ))}
      </Suspense>
    </div>
  );
}
