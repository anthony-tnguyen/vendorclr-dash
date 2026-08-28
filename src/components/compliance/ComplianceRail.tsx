import { ComplianceBadge } from "./ComplianceBadge";
import { COMPLIANCE_LABELS, STATUS_LABELS, type ComplianceItem } from "@/data/contracts";
import { cn } from "@/lib/utils";

export const RAIL_ORDER: ComplianceItem["key"][] = [
  "coi",
  "additionalInsured",
  "waiverOfSubrogation",
  "lienWaiver",
  "renewal",
];

export interface ComplianceRailProps {
  items: ComplianceItem[];
  vendorName: string;
  /** "row" is the compact roster rail, "detail" expands names and dates. */
  variant?: "row" | "detail";
  className?: string;
}

/**
 * Signature component: a fixed five-slot compliance rail so any vendor row can
 * be scanned in one pass — COI, Additional Insured, Waiver of Subrogation,
 * lien waiver, renewal.
 */
export function ComplianceRail({
  items,
  vendorName,
  variant = "row",
  className,
}: ComplianceRailProps) {
  const ordered = RAIL_ORDER.map(
    (key) =>
      items.find((i) => i.key === key) ?? {
        key,
        status: "missing" as const,
        effectiveDate: null,
      },
  );

  if (variant === "detail") {
    return (
      <ul
        aria-label={`Compliance rail for ${vendorName}`}
        className={cn("grid gap-2 sm:grid-cols-2 lg:grid-cols-5", className)}
      >
        {ordered.map((item) => (
          <li
            key={item.key}
            className="rounded-md border border-border bg-card p-3"
            data-testid={`rail-detail-${item.key}`}
          >
            <p className="text-xs font-semibold text-foreground">{COMPLIANCE_LABELS[item.key]}</p>
            <div className="mt-2">
              <ComplianceBadge item={item} />
            </div>
            <p className="numeric mt-2 text-xs text-muted-foreground">
              {item.effectiveDate ?? "No date on file"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {item.note ?? STATUS_LABELS[item.status]}
            </p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div
      aria-label={`Compliance rail for ${vendorName}`}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {ordered.map((item) => (
        <ComplianceBadge key={item.key} item={item} />
      ))}
    </div>
  );
}
