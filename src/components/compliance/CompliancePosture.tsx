import { cn } from "@/lib/utils";

type PostureTone = "danger" | "warn" | "ok" | "info" | "muted";

export interface CompliancePostureSegment {
  id: string;
  label: string;
  value: number;
  detail: string;
  tone: PostureTone;
}

export interface CompliancePostureProps {
  label: string;
  summary: string;
  segments: CompliancePostureSegment[];
}

const toneStyles: Record<PostureTone, { bar: string; value: string }> = {
  danger: { bar: "bg-destructive", value: "text-destructive" },
  warn: { bar: "bg-warn", value: "text-warn" },
  ok: { bar: "bg-ok", value: "text-ok" },
  info: { bar: "bg-primary", value: "text-primary" },
  muted: { bar: "bg-muted-foreground", value: "text-muted-foreground" },
};

/** A compact, data-derived read of the work currently in the register. */
export function CompliancePosture({ label, summary, segments }: CompliancePostureProps) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <section
      aria-label={label}
      className="border border-border bg-card px-4 py-4 shadow-[0_12px_28px_-24px_rgb(15_23_42/0.55)] sm:px-5"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{label}</h2>
        <p className="numeric text-xs text-muted-foreground">{summary}</p>
      </div>
      <div aria-hidden="true" className="mt-4 flex h-2 overflow-hidden rounded-full bg-muted">
        {segments.map((segment) => (
          <span
            key={segment.id}
            className={cn("min-w-0", toneStyles[segment.tone].bar)}
            style={{ flexGrow: total > 0 ? segment.value : 0 }}
          />
        ))}
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        {segments.map((segment) => (
          <div
            key={segment.id}
            aria-label={`${segment.label}: ${segment.value}, ${segment.detail}`}
          >
            <dt className="text-xs font-medium text-muted-foreground">{segment.label}</dt>
            <dd
              className={cn(
                "numeric mt-1 text-2xl font-semibold tracking-tight",
                toneStyles[segment.tone].value,
              )}
            >
              {segment.value}
            </dd>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{segment.detail}</p>
          </div>
        ))}
      </dl>
    </section>
  );
}
