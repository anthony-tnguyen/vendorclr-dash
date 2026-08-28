import type { ReactNode } from "react";
import { useDemoSession } from "@/app/App";
import { DeniedState } from "@/components/states/AsyncState";

/**
 * DEMO-ONLY gate. It reflects the demo role switcher for illustration and is
 * not an authorization boundary.
 */
export function AdminGuard({ children }: { children: ReactNode }) {
  const { role } = useDemoSession();
  if (role !== "admin") {
    return (
      <DeniedState description="This administrator view is hidden for the Customer demo role. Switch the demo role to Administrator in the sidebar to preview it. Demo mode only — no real permissions are involved." />
    );
  }
  return <>{children}</>;
}
