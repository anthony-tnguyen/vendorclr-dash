import { AlertTriangle, Check, Clock3, Minus } from "lucide-react";
import { RAIL_ORDER } from "./ComplianceRail";
import {
  COMPLIANCE_LABELS,
  COMPLIANCE_SHORT,
  STATUS_LABELS,
  type ComplianceItem,
} from "@/data/contracts";
import { cn } from "@/lib/utils";

export interface ComplianceMatrixProps {
  items: ComplianceItem[];
  vendorName: string;
  className?: string;
}

const statusStyles: Record<ComplianceItem["status"], string> = {
  compliant: "bg-ok-soft",
  expiring: "bg-warn-soft",
  pending: "bg-info-soft",
  missing: "bg-danger-soft",
  expired: "bg-danger-soft",
};

const statusIconStyles: Record<ComplianceItem["status"], string> = {
  compliant: "text-ok",
  expiring: "text-warn",
  pending: "text-primary",
  missing: "text-destructive",
  expired: "text-destructive",
};

function StatusIcon({
  status,
  className,
}: {
  status: ComplianceItem["status"];
  className: string;
}) {
  if (status === "compliant")
    return <Check aria-hidden="true" className={cn("size-3.5 stroke-[2.5]", className)} />;
  if (status === "expiring" || status === "pending")
    return <Clock3 aria-hidden="true" className={cn("size-3.5 stroke-[2.25]", className)} />;
  if (status === "missing" || status === "expired") {
    return <AlertTriangle aria-hidden="true" className={cn("size-3.5 stroke-[2.25]", className)} />;
  }
  return <Minus aria-hidden="true" className={cn("size-3.5 stroke-[2.25]", className)} />;
}

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
              "flex min-w-0 flex-col items-center gap-1 border-r border-border px-1 py-1.5 text-[9px] font-semibold uppercase tracking-wide last:border-r-0",
              statusStyles[item.status],
            )}
          >
            <StatusIcon status={item.status} className={statusIconStyles[item.status]} />
            <span className="truncate">{COMPLIANCE_SHORT[item.key]}</span>
          </span>
        );
      })}
    </div>
  );
}
