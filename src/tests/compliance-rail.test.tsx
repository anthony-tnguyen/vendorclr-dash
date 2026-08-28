import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComplianceRail, RAIL_ORDER } from "@/components/compliance/ComplianceRail";
import { ComplianceBadge } from "@/components/compliance/ComplianceBadge";
import type { ComplianceItem } from "@/data/contracts";

const items: ComplianceItem[] = [
  { key: "coi", status: "compliant", effectiveDate: "2026-11-30" },
  { key: "additionalInsured", status: "expiring", effectiveDate: "2026-09-14" },
  { key: "waiverOfSubrogation", status: "missing", effectiveDate: null },
  { key: "lienWaiver", status: "pending", effectiveDate: "2026-08-25" },
  { key: "renewal", status: "expired", effectiveDate: "2026-07-31" },
];

describe("ComplianceRail", () => {
  it("renders all five requirement slots in a fixed order", () => {
    render(<ComplianceRail items={items} vendorName="Corbett Structural Steel" />);
    const rail = screen.getByLabelText("Compliance rail for Corbett Structural Steel");
    const badges = within(rail).getAllByRole("status");
    expect(badges).toHaveLength(5);
    expect(badges.map((b) => b.getAttribute("data-requirement"))).toEqual(RAIL_ORDER);
  });

  it("exposes each requirement status through an accessible label", () => {
    render(<ComplianceRail items={items} vendorName="Rivera Electrical" />);
    expect(screen.getByLabelText(/^COI: Compliant/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Additional Insured: Expiring/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Waiver of Subrogation: Missing$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Lien Waiver: In review/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Renewal: Expired/)).toBeInTheDocument();
  });

  it("fills in a missing slot when a requirement has no record", () => {
    render(<ComplianceRail items={[items[0]!]} vendorName="Summit Earthworks" />);
    const rail = screen.getByLabelText("Compliance rail for Summit Earthworks");
    expect(within(rail).getAllByRole("status")).toHaveLength(5);
    expect(screen.getByLabelText("Lien Waiver: Missing")).toBeInTheDocument();
  });

  it("shows dates and notes in the detail variant", () => {
    render(<ComplianceRail items={items} vendorName="Delgado Concrete" variant="detail" />);
    expect(screen.getByText("Waiver of Subrogation")).toBeInTheDocument();
    expect(screen.getByText("2026-11-30")).toBeInTheDocument();
    expect(screen.getByText("No date on file")).toBeInTheDocument();
  });

  it("renders a badge with the verbose requirement name", () => {
    render(<ComplianceBadge item={items[1]!} verbose />);
    expect(screen.getByText("Additional Insured")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "expiring");
  });
});
