import { CheckCircle2, CircleDot, RotateCw, XCircle } from "lucide-react";
import { cn, dateTime, duration, STAGE_LABELS } from "@/lib/format";

export interface TimelineEvent {
  stage: string;
  status: string;
  message: string | null;
  duration_ms: number | null;
  actor?: string | null;
  created_at: string;
}

const ICONS: Record<string, React.ReactNode> = {
  completed: <CheckCircle2 className="h-4 w-4 text-ok" aria-label="Completed" />,
  failed: <XCircle className="h-4 w-4 text-danger" aria-label="Failed" />,
  retrying: <RotateCw className="h-4 w-4 text-warn" aria-label="Retrying" />,
};

/** Processing history: a real sequence, so it is drawn as one. */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <p className="text-sm text-muted">No activity recorded yet.</p>;
  return (
    <ol className="relative space-y-0">
      {events.map((e, i) => (
        <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
          {i < events.length - 1 && <span className="absolute top-5 left-[7.5px] h-[calc(100%-12px)] w-px bg-line" aria-hidden />}
          <span className="relative z-10 mt-0.5 bg-surface">{ICONS[e.status] ?? <CircleDot className="h-4 w-4 text-info" aria-label="Info" />}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn("text-sm font-medium", e.status === "failed" ? "text-danger" : "text-ink")}>{STAGE_LABELS[e.stage] ?? e.stage.replace(/-/g, " ")}</span>
              {e.duration_ms !== null && e.duration_ms !== undefined && <span className="num text-xs text-muted">{duration(e.duration_ms)}</span>}
              <span className="text-xs text-faint">{dateTime(e.created_at)}</span>
              {e.actor && <span className="text-xs text-faint">by {e.actor}</span>}
            </div>
            {e.message && <p className="mt-0.5 text-[13px] break-words text-ink-soft">{e.message}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
