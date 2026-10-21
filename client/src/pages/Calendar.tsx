import { Link } from "wouter";
import { SchedulingWorkspace } from "@/components/pages/SchedulingWorkspace";

// An owner calendar utility, independent of assistant creation and chat routing.
export default function Calendar() {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return (
    <main className="h-screen flex flex-col bg-background text-foreground">
      <header className="border-b px-6 py-3 flex items-center gap-6">
        <Link
          href="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          返回工作台
        </Link>
        <h1 className="text-base font-medium">我的日历</h1>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">
        <SchedulingWorkspace
          initialPage={
            tab === "settings"
              ? tab
              : "calendar"
          }
        />
      </div>
    </main>
  );
}
