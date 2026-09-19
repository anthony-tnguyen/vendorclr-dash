import { AlertTriangle, Check, Clock3, Minus } from "lucide-react";
import type { ComplianceItem } from "@/data/contracts";
import { cn } from "@/lib/utils";

/** Soft cell fills shared by the roster rail and the register matrix. */
export const statusCellStyles: Record<ComplianceItem["status"], string> = {
  compliant: "bg-ok-soft",
  expiring: "bg-warn-soft",
  pending: "bg-info-soft",
  missing: "bg-danger-soft",
  expired: "bg-danger-soft",
};

export const statusIconStyles: Record<ComplianceItem["status"], string> = {
  compliant: "text-ok",
  expiring: "text-warn",
  pending: "text-primary",
  missing: "text-destructive",
  expired: "text-destructive",
};

export function StatusIcon({
  status,
  className,
}: {
  status: ComplianceItem["status"];
  className?: string;
}) {
  if (status === "compliant")
    return <Check aria-hidden="true" className={cn("size-3.5 stroke-[2.5]", className)} />;
  if (status === "expiring" || status === "pending")
    return <Clock3 aria-hidden="true" className={cn("size-3.5 stroke-[2.25]", className)} />;
  if (status === "missing" || status === "expired")
    return <AlertTriangle aria-hidden="true" className={cn("size-3.5 stroke-[2.25]", className)} />;
  return <Minus aria-hidden="true" className={cn("size-3.5 stroke-[2.25]", className)} />;
}
