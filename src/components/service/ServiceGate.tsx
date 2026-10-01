import { useSession } from "@/app/App";

/**
 * The customer-facing half of the managed-service gate.
 *
 * While a paid workspace is still onboarding / in review, VendorClr has not turned
 * on managed service, so actions that send on the customer's behalf (vendor
 * document requests, renewal outreach, import-time dispatch) are held until
 * launch. The authoritative gate is server-side (a trigger on
 * vendor_upload_requests); this is the affordance that disables the control and
 * explains why, so the customer never fires a request the database will reject.
 *
 * Everything else in the console stays fully usable — this gates outbound only.
 */

export const SERVICE_LOCKED_REASON =
  "Your workspace is still being set up, so VendorClr isn't sending to vendors yet. This will be available once your workspace is live.";

export function useServiceGate(): { serviceLive: boolean; blockedReason: string | null } {
  const { serviceLive } = useSession();
  return { serviceLive, blockedReason: serviceLive ? null : SERVICE_LOCKED_REASON };
}

/** Inline note shown next to a disabled outbound control. */
export function ServiceLockedNote({ className }: { className?: string }) {
  return (
    <p
      className={
        className ??
        "rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn"
      }
    >
      {SERVICE_LOCKED_REASON}
    </p>
  );
}
