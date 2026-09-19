import { RAIL_ORDER } from "./ComplianceRail";
import { StatusIcon, statusCellStyles, statusIconStyles } from "./statusVisuals";
import { COMPLIANCE_LABELS, STATUS_LABELS, type ComplianceItem } from "@/data/contracts";
import { cn } from "@/lib/utils";

export interface ComplianceMatrixProps {
  items: ComplianceItem[];
  vendorName: string;
  className?: string;
}

const statusStyles = statusCellStyles;

const matrixLabels: Record<ComplianceItem["key"], string> = {
  coi: "COI",
  additionalInsured: "AI",
  waiverOfSubrogation: "WOS",
  lienWaiver: "LW",
  renewal: "REN",
};

/** A fixed five-slot compliance read designed for register rows, not a replacement for the compact rail. */
export function ComplianceMatrix({ items, vendorName, className }: ComplianceMatrixProps) {
  const ordered = RAIL_ORDER.map(
    (key) =>
      items.find((item) => item.key === key) ?? {
        key,
        status: "missing" as const,
        effectiveDate: null,
      },
  );

  return (
    <div
      aria-label={`Compliance matrix for ${vendorName}`}
      className={cn("grid grid-cols-5 overflow-hidden border border-border bg-card", className)}
    >
      {ordered.map((item) => {
        const aria = `${COMPLIANCE_LABELS[item.key]}: ${STATUS_LABELS[item.status]}${
          item.effectiveDate ? `, dated ${item.effectiveDate}` : ""
        }`;
        return (
          <span
            key={item.key}
            role="status"
            aria-label={aria}
            title={aria}
            data-status={item.status}
            data-requirement={item.key}
            className={cn(
              "flex min-w-0 flex-col items-center gap-1.5 border-r border-border px-1.5 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] last:border-r-0",
              statusStyles[item.status],
            )}
          >
            <StatusIcon status={item.status} className={statusIconStyles[item.status]} />
            <span>{matrixLabels[item.key]}</span>
          </span>
        );
      })}
    </div>
  );
}
