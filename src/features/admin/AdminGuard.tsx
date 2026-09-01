import type { ReactNode } from "react";
import { useSession } from "@/app/App";
import { DeniedState } from "@/components/states/AsyncState";

/**
 * Hides administrator views from non-staff.
 *
 * This is presentation, not security. It exists so the wrong console is not shown,
 * and nothing more. The real boundary is RLS: leads are staff-only in every
 * direction, and every customer table is scoped to the caller's company. A user who
 * routes around this component still reads nothing they should not see.
 */
export function AdminGuard({ children }: { children: ReactNode }) {
  const { role, mode, status } = useSession();

  if (mode === "live" && status === "loading") return null;

  if (role !== "admin") {
    return (
      <DeniedState
        description={
          mode === "demo"
            ? "This administrator view is hidden for the Customer demo role. Switch the demo role to Administrator in the sidebar to preview it. Demo mode only — no real permissions are involved."
            : "This administrator view is limited to VendorClear staff accounts."
        }
      />
    );
  }

  return <>{children}</>;
}
