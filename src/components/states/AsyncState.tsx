import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function LoadingState({
  label = "Loading data",
  rows = 4,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-live="polite" className="rounded-md border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}…</p>
      <div className="mt-3 space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-8 rounded-sm bg-muted" />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-border bg-card p-6 text-center">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Could not load this view",
  description,
  onRetry,
}: {
  title?: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-danger-soft p-4">
      <h3 className="text-sm font-semibold text-destructive">{title}</h3>
      <p className="mt-1 text-sm text-foreground">{description}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="focusable mt-3 rounded-sm border border-destructive/40 bg-card px-3 py-1.5 text-sm font-medium text-destructive"
        >
          Retry loading
        </button>
      ) : null}
    </div>
  );
}

export function DeniedState({
  title = "Access denied",
  description,
}: {
  title?: string;
  description: string;
}) {
  return (
    <div role="alert" className="rounded-md border border-warn/40 bg-warn-soft p-4">
      <h3 className="text-sm font-semibold text-warn">{title}</h3>
      <p className="mt-1 text-sm text-foreground">{description}</p>
    </div>
  );
}

export function StateGallery({ className }: { className?: string }) {
  return (
    <section aria-labelledby="state-gallery" className={cn("space-y-3", className)}>
      <h2 id="state-gallery" className="text-sm font-semibold text-foreground">
        Interface state examples
      </h2>
      <div className="grid gap-3 lg:grid-cols-2">
        <LoadingState label="Loading vendor certificates" rows={2} />
        <EmptyState
          title="No exceptions on this project"
          description="Every tracked requirement is current. New exceptions appear here as certificates lapse."
        />
        <ErrorState description="Demo data source did not respond. Nothing was changed." />
        <DeniedState description="Your demo role cannot open administrator views. Switch the demo role to Administrator to preview them." />
      </div>
    </section>
  );
}
