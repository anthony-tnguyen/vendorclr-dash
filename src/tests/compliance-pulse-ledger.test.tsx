import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComplianceMatrix } from "@/components/compliance/ComplianceMatrix";
import { CompliancePosture } from "@/components/compliance/CompliancePosture";
import type { ComplianceItem } from "@/data/contracts";

const items: ComplianceItem[] = [
  { key: "coi", status: "compliant", effectiveDate: "2026-11-30" },
  { key: "additionalInsured", status: "expiring", effectiveDate: "2026-09-14" },
  { key: "waiverOfSubrogation", status: "missing", effectiveDate: null },
  { key: "lienWaiver", status: "pending", effectiveDate: "2026-08-25" },
  { key: "renewal", status: "expired", effectiveDate: "2026-07-31" },
];

describe("Compliance Pulse Ledger primitives", () => {
  it("makes each posture count and status meaning accessible", () => {
    render(
      <CompliancePosture
        label="Compliance posture"
        summary="10 vendors"
        segments={[
          { id: "urgent", label: "Urgent", value: 2, detail: "Needs action", tone: "danger" },
          { id: "clear", label: "Clear", value: 8, detail: "Requirements current", tone: "ok" },
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: "Compliance posture" })).toHaveTextContent(
      "10 vendors",
    );
    expect(screen.getByLabelText("Urgent: 2, Needs action")).toBeInTheDocument();
    expect(screen.getByLabelText("Clear: 8, Requirements current")).toBeInTheDocument();
  });

  it("renders every requirement as an accessible fixed matrix slot", () => {
    render(<ComplianceMatrix items={items} vendorName="Corbett Structural Steel" />);

    const matrix = screen.getByLabelText("Compliance matrix for Corbett Structural Steel");
    expect(within(matrix).getAllByRole("status")).toHaveLength(5);
    expect(within(matrix).getByText("AI")).toBeInTheDocument();
    expect(within(matrix).getByText("LW")).toBeInTheDocument();
    expect(within(matrix).queryByText("Add Ins")).not.toBeInTheDocument();
    expect(within(matrix).queryByText("Lien Waiver")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^COI: Compliant/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Renewal: Expired/)).toBeInTheDocument();
  });
});
