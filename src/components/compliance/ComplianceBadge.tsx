import {
  COMPLIANCE_LABELS,
  COMPLIANCE_SHORT,
  STATUS_LABELS,
  type ComplianceItem,
} from "@/data/contracts";
import { cn } from "@/lib/utils";

const statusStyles: Record<ComplianceItem["status"], string> = {
  compliant: "bg-ok-soft text-ok border-ok/30",
  expiring: "bg-warn-soft text-warn border-warn/30",
  pending: "bg-info-soft text-primary border-primary/30",
  missing: "bg-danger-soft text-destructive border-destructive/30",
  expired: "bg-danger-soft text-destructive border-destructive/40",
};

const statusMark: Record<ComplianceItem["status"], string> = {
  compliant: "OK",
  expiring: "30D",
  pending: "REV",
  missing: "—",
  expired: "EXP",
};

export interface ComplianceBadgeProps {
  item: ComplianceItem;
  /** Show the full requirement name instead of the short code. */
  verbose?: boolean;
  className?: string;
}

export function ComplianceBadge({ item, verbose = false, className }: ComplianceBadgeProps) {
  const name = verbose ? COMPLIANCE_LABELS[item.key] : COMPLIANCE_SHORT[item.key];
  const aria = `${COMPLIANCE_LABELS[item.key]}: ${STATUS_LABELS[item.status]}${
    item.effectiveDate ? `, dated ${item.effectiveDate}` : ""
  }`;

  return (
    <span
      role="status"
      aria-label={aria}
      title={aria}
      data-status={item.status}
      data-requirement={item.key}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        statusStyles[item.status],
        className,
      )}
    >
      <span>{name}</span>
      <span className="numeric text-[10px] font-medium opacity-80">{statusMark[item.status]}</span>
    </span>
  );
}
