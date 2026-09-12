# Compliance Pulse Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the customer and administrator home screens as a premium, evidence-dense Compliance Pulse Ledger without changing routes, data contracts, or actions.

**Architecture:** Add two reusable presentational compliance primitives: a semantic posture bar for existing state counts and a five-slot checkmark matrix for existing requirement data. Integrate them only into the two home screens, retaining their existing ranked queue, selected inspector, links, loading/error/empty states, and live/demo action branching.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, TanStack Router/Query, Vitest, Testing Library.

**Spec:** Approved Compliance Pulse Ledger direction from this task conversation (2026-09-12).

## Global Constraints

- Preserve the existing customer and administrator routes, repository calls, role guard, inspector controls, and live/demo behavior.
- Use only current semantic VendorClr tokens; no gradients, decorative analytics, fabricated data, or new backend behavior.
- Keep the customer `Needs action now` queue and Resolution Inspector; keep the admin Review Queue and Review Inspector.
- The customer posture reflects existing compliance statuses; the admin posture reflects existing queue states.
- The full register/matrix treatment appears on these two homes only; existing compact compliance rails stay unchanged elsewhere.
- Add accessible labels for every posture segment and compliance-matrix requirement.

---

### Task 1: Add reusable posture and ledger-matrix primitives

**Files:**

- Create: `src/components/compliance/CompliancePosture.tsx`
- Create: `src/components/compliance/ComplianceMatrix.tsx`
- Test: `src/tests/compliance-pulse-ledger.test.tsx`

**Interfaces:**

- Consumes: `ComplianceItem` and `ComplianceStatus` from `src/data/contracts.ts`.
- Produces: `CompliancePosture({ label, summary, segments })` and `ComplianceMatrix({ items, vendorName })` for the two overview pages.

- [ ] **Step 1: Write failing component tests**

```tsx
it("renders semantic posture segments with counts", () => {
  render(
    <CompliancePosture
      label="Compliance posture"
      summary="10 vendors"
      segments={[
        { id: "urgent", label: "Urgent", value: 2, detail: "Needs action", tone: "danger" },
      ]}
    />,
  );
  expect(screen.getByLabelText("Urgent: 2, Needs action")).toBeInTheDocument();
});

it("renders five accessible requirement slots in a checkmark matrix", () => {
  render(<ComplianceMatrix items={items} vendorName="Corbett Structural Steel" />);
  expect(
    within(screen.getByLabelText("Compliance matrix for Corbett Structural Steel")).getAllByRole(
      "status",
    ),
  ).toHaveLength(5);
});
```

- [ ] **Step 2: Run tests to verify the expected missing-module failure**

Run: `bunx vitest run src/tests/compliance-pulse-ledger.test.tsx`

Expected: FAIL because `CompliancePosture` and `ComplianceMatrix` do not exist.

- [ ] **Step 3: Implement the minimal accessible primitives**

```tsx
export function CompliancePosture({ label, summary, segments }: CompliancePostureProps) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <section aria-label={label}>{/* token-backed segmented bar and segment labels */}</section>
  );
}
```

```tsx
export function ComplianceMatrix({ items, vendorName }: ComplianceMatrixProps) {
  return (
    <div aria-label={`Compliance matrix for ${vendorName}`}>
      {/* one fixed slot per RAIL_ORDER key */}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify the primitives pass**

Run: `bunx vitest run src/tests/compliance-pulse-ledger.test.tsx`

Expected: PASS.

### Task 2: Apply the ledger treatment to the customer command center

**Files:**

- Modify: `src/features/overview/OverviewPage.tsx`
- Modify: `src/tests/command-queue.test.tsx`

**Interfaces:**

- Consumes: `CompliancePosture`, `ComplianceMatrix`, existing vendor data, `primaryException`, `statusRank`.
- Produces: an existing-behavior customer home with a posture bar and row-level compliance matrix.

- [ ] **Step 1: Write the failing customer route assertion**

```tsx
expect(await screen.findByRole("region", { name: "Compliance posture" })).toBeInTheDocument();
expect(screen.getByLabelText("Compliance matrix for Delgado Concrete Works")).toBeInTheDocument();
```

- [ ] **Step 2: Run the focused route test and verify it fails**

Run: `bunx vitest run src/tests/command-queue.test.tsx`

Expected: FAIL because the customer home has neither the posture region nor the matrix.

- [ ] **Step 3: Integrate existing compliance counts and the matrix**

```tsx
const posture = useMemo(() => /* classify existing vendor compliance into urgent, expiring, clear */, [vendors.data]);

<CompliancePosture label="Compliance posture" summary="Current requirement status" segments={posture} />
<ComplianceMatrix items={vendor.compliance} vendorName={vendor.name} />
```

- [ ] **Step 4: Run the focused route test and verify it passes**

Run: `bunx vitest run src/tests/command-queue.test.tsx`

Expected: PASS while retaining the selected Resolution Inspector behavior.

### Task 3: Apply the parallel posture treatment to the administrator review queue

**Files:**

- Modify: `src/features/admin/AdminOverviewPage.tsx`
- Modify: `src/tests/command-queue.test.tsx`

**Interfaces:**

- Consumes: `CompliancePosture`, existing `activeQueue`, `queueRank`, and review inspector behavior.
- Produces: an existing-behavior admin home with a queue-state posture bar and a more legible document register.

- [ ] **Step 1: Write the failing administrator route assertion**

```tsx
expect(await screen.findByRole("region", { name: "Review posture" })).toBeInTheDocument();
expect(screen.getByLabelText("Escalated: 1, Needs reviewer attention")).toBeInTheDocument();
```

- [ ] **Step 2: Run the focused route test and verify it fails**

Run: `bunx vitest run src/tests/command-queue.test.tsx`

Expected: FAIL because the administrator home has no review posture region.

- [ ] **Step 3: Integrate existing queue-state counts and premium register hierarchy**

```tsx
<CompliancePosture
  label="Review posture"
  summary="Current document workload"
  segments={reviewPosture}
/>
```

Use only semantic token-backed colors, crisp table dividers, and restrained surface elevation; retain every existing selection and review action.

- [ ] **Step 4: Run the focused route test and verify it passes**

Run: `bunx vitest run src/tests/command-queue.test.tsx`

Expected: PASS while retaining the selected Review Inspector and `Open review` control.

### Task 4: Verify and finish the UI change

**Files:**

- Modify: only files from Tasks 1-3 if mechanical formatting is required.

- [ ] **Step 1: Run static checks and all unit tests**

Run: `bun run lint; bun run test`

Expected: PASS, with any known baseline warnings identified separately.

- [ ] **Step 2: Run the production build**

Run: `bun run build`

Expected: PASS.

- [ ] **Step 3: Capture desktop and mobile renders once, correct material gaps in one batch, and capture once more**

Run the local Vite app, inspect `/dashboard` and `/dashboard/admin` at desktop and mobile widths, and retain accessibility focus/overflow behavior.

- [ ] **Step 4: Run the Impeccable detector on changed UI files**

Run: `impeccable detect --json`

Expected: no mechanical issues, or report any remaining tool limitation.
