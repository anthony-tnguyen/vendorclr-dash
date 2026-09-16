import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { isBackendConfigured } from "@/data/repository";
import { getOperationalFailures, type OperationalFailuresSummary } from "@/workflows/operations";

/**
 * Internal operations screen - Task 2 (Engineer A)'s minimal, functional
 * proof that the whole observability pipeline works end to end: real data
 * from getOperationalFailures(), real loading/error/empty states, gated
 * behind AdminGuard. Deliberately plain (one table per signal, no filters,
 * no pagination, none of the visual system other pages use) - a later task
 * redesigns this; see the Task 2 plan's own scope boundary.
 */

function AlertsSection({ alerts }: { alerts: OperationalFailuresSummary["alerts"] }) {
  const firing = alerts.filter((a) => a.firing);
  if (firing.length === 0) {
    return (
      <p className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
        No alerts are currently firing.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {firing.map((alert) => (
        <li
          key={alert.key}
          role="alert"
          className={`rounded-sm border px-3 py-2 text-xs ${
            alert.severity === "critical"
              ? "border-destructive/40 bg-danger-soft text-destructive"
              : "border-warn/40 bg-warn-soft text-warn"
          }`}
        >
          <span className="font-semibold uppercase tracking-wide">{alert.severity}</span> ·{" "}
          {alert.message}
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`ops-${title}`} className="space-y-2">
      <h2 id={`ops-${title}`} className="text-sm font-semibold text-foreground">
        {title} <span className="text-muted-foreground">({count})</span>
      </h2>
      {count === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing here right now.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">{children}</div>
      )}
    </section>
  );
}

export function OperationsPage() {
  const isDemo = !isBackendConfigured();
  const operations = useQuery({
    queryKey: ["admin", "operations"],
    queryFn: () => getOperationalFailures(),
    enabled: !isDemo,
  });

  return (
    <AppShell
      title="Operations"
      subtitle="Failed jobs, stale reviews, delivery problems and scheduled-job health across every company."
    >
      <AdminGuard>
        {isDemo ? (
          <EmptyState
            title="Operations requires a live backend"
            description="This screen reads real Supabase data (extraction failures, review queue age, email delivery, scheduled jobs) and has no demo-mode equivalent. Configure VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY to use it."
          />
        ) : operations.isLoading ? (
          <LoadingState label="Loading operations data" rows={5} />
        ) : operations.isError ? (
          <ErrorState
            description={
              operations.error instanceof Error
                ? operations.error.message
                : "Could not load operations data."
            }
            onRetry={() => void operations.refetch()}
          />
        ) : !operations.data ? (
          <EmptyState title="No data" description="Nothing was returned." />
        ) : (
          <div className="space-y-8">
            <p className="text-xs text-muted-foreground">
              Generated {new Date(operations.data.generatedAt).toLocaleString()} · Oldest open queue
              item:{" "}
              {operations.data.oldestQueueAgeHours === null
                ? "none open"
                : `${operations.data.oldestQueueAgeHours}h ago`}{" "}
              · Database size: {(operations.data.storage.usedBytes / (1024 * 1024)).toFixed(1)} MB
              of {(operations.data.storage.capacityBytes / (1024 * 1024 * 1024)).toFixed(0)} GiB
              placeholder capacity
            </p>

            <section aria-labelledby="ops-alerts" className="space-y-2">
              <h2 id="ops-alerts" className="text-sm font-semibold text-foreground">
                Alerts
              </h2>
              <AlertsSection alerts={operations.data.alerts} />
            </section>

            <Section
              title="Failed and exhausted extraction jobs"
              count={operations.data.failedExtractionJobs.length}
            >
              <table className="w-full min-w-[640px] text-left text-sm">
                <caption className="sr-only">Failed extraction jobs</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Document</th>
                    <th className="px-3 py-2 font-medium">Company</th>
                    <th className="px-3 py-2 font-medium">Retries</th>
                    <th className="px-3 py-2 font-medium">Exhausted</th>
                    <th className="px-3 py-2 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.data.failedExtractionJobs.map((job) => (
                    <tr key={job.documentId} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-xs">{job.fileName}</td>
                      <td className="numeric px-3 py-2 text-xs">{job.companyId}</td>
                      <td className="numeric px-3 py-2 text-xs">{job.retryCount}</td>
                      <td className="px-3 py-2 text-xs">{job.exhausted ? "Yes" : "No"}</td>
                      <td className="px-3 py-2 text-xs">{job.processingError ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section title="Stale review items" count={operations.data.staleReviewItems.length}>
              <table className="w-full min-w-[560px] text-left text-sm">
                <caption className="sr-only">Stale review items</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Document</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2 font-medium">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.data.staleReviewItems.map((item) => (
                    <tr key={item.queueItemId} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-xs">{item.documentLabel}</td>
                      <td className="px-3 py-2 text-xs uppercase">{item.state}</td>
                      <td className="numeric px-3 py-2 text-xs">{item.ageHours}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section
              title="Bounced or complained email"
              count={operations.data.bouncedEmail.length}
            >
              <table className="w-full min-w-[480px] text-left text-sm">
                <caption className="sr-only">Bounced or complained email</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Event</th>
                    <th className="px-3 py-2 font-medium">Company</th>
                    <th className="px-3 py-2 font-medium">Occurred</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.data.bouncedEmail.map((event) => (
                    <tr key={event.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-xs uppercase">{event.eventType}</td>
                      <td className="numeric px-3 py-2 text-xs">{event.companyId}</td>
                      <td className="numeric px-3 py-2 text-xs">
                        {new Date(event.occurredAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section
              title="Malware scan unknown or error"
              count={operations.data.malwareFlagged.length}
            >
              <table className="w-full min-w-[480px] text-left text-sm">
                <caption className="sr-only">Documents with an unresolved malware scan</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Document</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.data.malwareFlagged.map((doc) => (
                    <tr key={doc.documentId} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-xs">{doc.fileName}</td>
                      <td className="px-3 py-2 text-xs uppercase">{doc.malwareScanStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section title="Scheduled jobs" count={operations.data.scheduledJobs.length}>
              <table className="w-full min-w-[560px] text-left text-sm">
                <caption className="sr-only">Scheduled job run health</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Job</th>
                    <th className="px-3 py-2 font-medium">Most recent runs</th>
                    <th className="px-3 py-2 font-medium">Alert</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.data.scheduledJobs.map((job) => (
                    <tr key={job.jobName} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-xs">{job.jobName}</td>
                      <td className="px-3 py-2 text-xs">
                        {job.recentRuns
                          .slice(0, 5)
                          .map((r) => r.status)
                          .join(", ") || "no runs recorded"}
                      </td>
                      <td className="px-3 py-2 text-xs">{job.alert.firing ? "Firing" : "OK"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </div>
        )}
      </AdminGuard>
    </AppShell>
  );
}
