import { useQuery } from "@tanstack/react-query";

import { getRepository } from "@/data/repository";

/**
 * The ~90%-utilization notice.
 *
 * VendorClr's pricing rule is "notify near the limit, never block": a company
 * approaching its plan's active-vendor ceiling is told so plainly, but nothing
 * stops them adding vendors and there is no surprise overage charge. This
 * surfaces active-vendor usage from getVendorUsage() (company_vendor_usage in
 * live mode) and renders only once usage crosses the threshold on a plan that
 * has a ceiling. Enterprise (no ceiling) and low-usage companies see nothing.
 */

/** Show the notice once a company is using this share of its ceiling. */
export const UTILIZATION_NOTICE_AT = 0.9;

export function VendorUsageNotice() {
  const usage = useQuery({
    queryKey: ["vendor-usage"],
    queryFn: () => getRepository().getVendorUsage(),
  });

  const data = usage.data;
  // No ceiling (Enterprise), still loading, or comfortably under the threshold:
  // this notice stays out of the way.
  if (!data || data.maxActiveVendors == null || data.utilization < UTILIZATION_NOTICE_AT) {
    return null;
  }

  const atLimit = data.activeVendors >= data.maxActiveVendors;
  const pct = Math.round(data.utilization * 100);

  return (
    <div
      role="status"
      className="rounded-md border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn"
    >
      <p className="font-semibold text-foreground">
        {atLimit
          ? "You've reached your plan's active-vendor limit"
          : "You're approaching your plan's active-vendor limit"}
      </p>
      <p className="mt-1 text-muted-foreground">
        {data.activeVendors} of {data.maxActiveVendors} active vendors ({pct}%). You won&apos;t be
        blocked and there&apos;s no surprise overage charge — your VendorClr contact will reach out
        about the right plan as you grow.
      </p>
    </div>
  );
}
