import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateBounceRateAlert,
  evaluateExhaustedRetryAlert,
  evaluateExtractionFailureRateAlert,
  evaluateMissedScheduledJobAlert,
  evaluateReadinessAlert,
  evaluateStorageCapacityAlert,
  groupCronRunsByJob,
  notifyAlert,
  RETRY_CAP,
  type OperationalFailuresSummary,
} from "@/workflows/operations";

// vi.mock() calls are hoisted above every import in this file by Vitest's
// compiler transform, so OperationsPage below always sees the mocked
// @/app/App, @/components/shell/AppShell, @/data/repository and
// @/workflows/operations - regardless of import order in the source.
import { OperationsPage } from "@/features/admin/OperationsPage";

/**
 * Two halves: pure alert-condition unit tests (the six conditions from the
 * Task 2 plan's checklist, each proven firing and not-firing - these need
 * no mocking, they are ordinary pure functions) and OperationsPage
 * component tests (real loading/error/empty/success states, gated behind
 * AdminGuard - the plan's "minimal, functional" bar for this screen).
 *
 * getOperationalFailures() itself (the createServerFn/Supabase-querying
 * half) is deliberately NOT unit-tested here with a mocked Supabase client -
 * that would mostly prove this file's own mock was self-consistent. Its
 * platform-admin gating is proven for real, against real Postgres RLS, in
 * supabase/tests/operations-visibility.test.ts instead.
 */

describe("alert conditions", () => {
  describe("evaluateReadinessAlert() - readiness down 5 minutes", () => {
    it("does not fire under 5 minutes of continuous failure", () => {
      expect(evaluateReadinessAlert({ continuousFailureDurationMs: 4 * 60 * 1000 }).firing).toBe(
        false,
      );
    });

    it("fires at exactly 5 minutes of continuous failure", () => {
      expect(evaluateReadinessAlert({ continuousFailureDurationMs: 5 * 60 * 1000 }).firing).toBe(
        true,
      );
    });

    it("does not fire when there has been no failure at all", () => {
      expect(evaluateReadinessAlert({ continuousFailureDurationMs: 0 }).firing).toBe(false);
    });
  });

  describe("evaluateMissedScheduledJobAlert() - a job missed twice", () => {
    it("fires when the two most recent runs both failed", () => {
      const result = evaluateMissedScheduledJobAlert({
        jobName: "retry-failed-documents-hourly",
        recentRuns: [
          { status: "failed", startedAt: new Date("2026-09-15T10:00:00Z") },
          { status: "failed", startedAt: new Date("2026-09-15T09:00:00Z") },
          { status: "succeeded", startedAt: new Date("2026-09-15T08:00:00Z") },
        ],
      });
      expect(result.firing).toBe(true);
    });

    it("does not fire when only the most recent run failed", () => {
      const result = evaluateMissedScheduledJobAlert({
        jobName: "send-renewal-reminders-daily",
        recentRuns: [
          { status: "failed", startedAt: new Date("2026-09-15T13:00:00Z") },
          { status: "succeeded", startedAt: new Date("2026-09-14T13:00:00Z") },
        ],
      });
      expect(result.firing).toBe(false);
    });

    it("does not fire with fewer than two recorded runs", () => {
      const result = evaluateMissedScheduledJobAlert({
        jobName: "brand-new-job",
        recentRuns: [{ status: "failed", startedAt: new Date() }],
      });
      expect(result.firing).toBe(false);
    });

    it("does not fire with no recorded runs at all", () => {
      expect(evaluateMissedScheduledJobAlert({ jobName: "never-run", recentRuns: [] }).firing).toBe(
        false,
      );
    });
  });

  describe("evaluateExtractionFailureRateAlert() - >5% over 30 minutes", () => {
    it("fires above 5%", () => {
      expect(
        evaluateExtractionFailureRateAlert({ totalProcessed: 100, totalFailed: 6 }).firing,
      ).toBe(true);
    });

    it("does not fire at exactly 5%", () => {
      expect(
        evaluateExtractionFailureRateAlert({ totalProcessed: 100, totalFailed: 5 }).firing,
      ).toBe(false);
    });

    it("does not fire with zero attempts in the window", () => {
      expect(evaluateExtractionFailureRateAlert({ totalProcessed: 0, totalFailed: 0 }).firing).toBe(
        false,
      );
    });
  });

  describe("evaluateExhaustedRetryAlert() - any exhausted retry", () => {
    it("fires on a single exhausted document", () => {
      expect(evaluateExhaustedRetryAlert({ exhaustedCount: 1 }).firing).toBe(true);
    });

    it("does not fire on zero", () => {
      expect(evaluateExhaustedRetryAlert({ exhaustedCount: 0 }).firing).toBe(false);
    });

    it("mentions the retry cap in its message", () => {
      const result = evaluateExhaustedRetryAlert({ exhaustedCount: 2 });
      expect(result.message).toContain(String(RETRY_CAP));
    });
  });

  describe("evaluateBounceRateAlert() - >5% over 24 hours", () => {
    it("fires above 5%", () => {
      expect(evaluateBounceRateAlert({ totalSent: 100, totalBounced: 6 }).firing).toBe(true);
    });

    it("does not fire at exactly 5%", () => {
      expect(evaluateBounceRateAlert({ totalSent: 100, totalBounced: 5 }).firing).toBe(false);
    });

    it("does not fire with zero sends in the window", () => {
      expect(evaluateBounceRateAlert({ totalSent: 0, totalBounced: 0 }).firing).toBe(false);
    });
  });

  describe("evaluateStorageCapacityAlert() - >80% capacity", () => {
    it("fires above 80%", () => {
      expect(evaluateStorageCapacityAlert({ usedBytes: 81, capacityBytes: 100 }).firing).toBe(true);
    });

    it("does not fire at exactly 80%", () => {
      expect(evaluateStorageCapacityAlert({ usedBytes: 80, capacityBytes: 100 }).firing).toBe(
        false,
      );
    });

    it("does not fire with zero capacity configured", () => {
      expect(evaluateStorageCapacityAlert({ usedBytes: 50, capacityBytes: 0 }).firing).toBe(false);
    });
  });
});

describe("groupCronRunsByJob()", () => {
  it("groups rows by job name, preserving newest-first order within each job", () => {
    const grouped = groupCronRunsByJob([
      { job_name: "job-a", status: "succeeded", start_time: "2026-09-15T10:00:00Z" },
      { job_name: "job-b", status: "failed", start_time: "2026-09-15T09:30:00Z" },
      { job_name: "job-a", status: "failed", start_time: "2026-09-15T09:00:00Z" },
    ]);

    expect(grouped).toHaveLength(2);
    const jobA = grouped.find((j) => j.jobName === "job-a");
    expect(jobA?.recentRuns.map((r) => r.status)).toEqual(["succeeded", "failed"]);
  });

  it("returns an empty list for no rows", () => {
    expect(groupCronRunsByJob([])).toEqual([]);
  });
});

describe("notifyAlert() - the alert-delivery seam", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does nothing for a non-firing alert", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await notifyAlert({ key: "x", firing: false, severity: "warning", message: "fine" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs rather than delivering when no webhook is configured", async () => {
    vi.stubEnv("VITE_ALERT_WEBHOOK_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await notifyAlert({
      key: "readiness_down_5m",
      firing: true,
      severity: "critical",
      message: "down",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("alert_fired_no_provider_configured");
  });

  it("POSTs to the configured webhook when one is set", async () => {
    vi.stubEnv("VITE_ALERT_WEBHOOK_URL", "https://hooks.example.test/alert");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    await notifyAlert({
      key: "bounce_rate",
      firing: true,
      severity: "warning",
      message: "bouncing",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.example.test/alert",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("never throws when the webhook delivery itself fails", async () => {
    vi.stubEnv("VITE_ALERT_WEBHOOK_URL", "https://hooks.example.test/alert");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(
      notifyAlert({ key: "bounce_rate", firing: true, severity: "warning", message: "bouncing" }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OperationsPage component tests
// ---------------------------------------------------------------------------

// vi.mock() factories are hoisted above plain `const`/`let` declarations in
// this file, so a mock helper referenced inside one must go through
// vi.hoisted() - otherwise the factory runs before the plain `const` below
// it has been initialized (a real TDZ error, not a style preference).
const { getOperationalFailuresMock, backendConfigured } = vi.hoisted(() => ({
  getOperationalFailuresMock: vi.fn(),
  backendConfigured: { value: true },
}));

vi.mock("@/workflows/operations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/workflows/operations")>();
  return { ...actual, getOperationalFailures: () => getOperationalFailuresMock() };
});

vi.mock("@/app/App", () => ({
  useSession: () => ({
    mode: "live",
    status: "authenticated",
    role: "admin",
    setRole: vi.fn(),
    canSwitchRole: false,
    personName: "Ops Admin",
    companyName: "VendorClr Internal",
    userId: "staff-1",
    signOut: vi.fn(),
  }),
}));

vi.mock("@/components/shell/AppShell", () => ({
  AppShell: ({
    title,
    subtitle,
    children,
  }: PropsWithChildren<{ title: string; subtitle?: string }>) => (
    <main>
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
      {children}
    </main>
  ),
}));

vi.mock("@/data/repository", () => ({
  isBackendConfigured: () => backendConfigured.value,
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OperationsPage />
    </QueryClientProvider>,
  );
}

function main() {
  return within(screen.getByRole("main"));
}

function summaryFixture(
  overrides: Partial<OperationalFailuresSummary> = {},
): OperationalFailuresSummary {
  return {
    generatedAt: "2026-09-15T12:00:00.000Z",
    failedExtractionJobs: [],
    staleReviewItems: [],
    bouncedEmail: [],
    malwareFlagged: [],
    scheduledJobs: [],
    oldestQueueAgeHours: null,
    storage: { usedBytes: 1024, capacityBytes: 1024 * 1024 * 1024 },
    alerts: [],
    ...overrides,
  };
}

describe("OperationsPage", () => {
  afterEach(() => {
    getOperationalFailuresMock.mockReset();
    backendConfigured.value = true;
  });

  it("shows a no-backend message instead of calling the server function in demo mode", async () => {
    backendConfigured.value = false;
    renderPage();

    expect(await main().findByText(/operations requires a live backend/i)).toBeInTheDocument();
    expect(getOperationalFailuresMock).not.toHaveBeenCalled();
  });

  it("shows a loading state while the query is in flight", () => {
    getOperationalFailuresMock.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(main().getByRole("status")).toHaveTextContent(/loading operations data/i);
  });

  it("shows an error state, with a retry, when the server function rejects", async () => {
    getOperationalFailuresMock.mockRejectedValue(
      new Error("This action is limited to VendorClr staff accounts."),
    );
    renderPage();

    expect(
      await main().findByText("This action is limited to VendorClr staff accounts."),
    ).toBeInTheDocument();
    expect(main().getByRole("button", { name: /retry loading/i })).toBeInTheDocument();
  });

  it("renders an empty-per-section state when every signal is clean", async () => {
    getOperationalFailuresMock.mockResolvedValue(summaryFixture());
    renderPage();

    expect(await main().findByText(/no alerts are currently firing/i)).toBeInTheDocument();
    expect(main().getByRole("region", { name: "Operations snapshot" })).toHaveTextContent(
      "Active signals",
    );
    expect(main().getByText("0.0 MB")).toBeInTheDocument();
    expect(main().getAllByText(/nothing here right now/i).length).toBeGreaterThan(0);
  });

  it("renders real rows for a failed/exhausted extraction job and a firing alert", async () => {
    getOperationalFailuresMock.mockResolvedValue(
      summaryFixture({
        failedExtractionJobs: [
          {
            documentId: "doc-1",
            companyId: "company-1",
            vendorId: "vendor-1",
            fileName: "coi.pdf",
            retryCount: RETRY_CAP,
            exhausted: true,
            processingError: "Unreadable PDF",
          },
        ],
        alerts: [
          {
            key: "exhausted_retry",
            firing: true,
            severity: "warning",
            message: "1 document exhausted retries.",
          },
        ],
      }),
    );
    renderPage();

    expect(await main().findByText("coi.pdf")).toBeInTheDocument();
    expect(main().getByText("Unreadable PDF")).toBeInTheDocument();
    expect(main().getByRole("alert")).toHaveTextContent("1 document exhausted retries.");
  });
});
