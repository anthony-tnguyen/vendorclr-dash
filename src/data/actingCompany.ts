/**
 * "Act as company" context for VendorClr staff.
 *
 * A platform admin belongs to no company, so the customer console has no company
 * to scope to. When staff "enter" a company from the admin Companies page, that
 * company id is held here: the repository uses it as the company for writes
 * (resolveCompanyId) and as an explicit filter on company-scoped reads, since a
 * platform admin's RLS reads would otherwise return every company's rows.
 *
 * This is a per-tab module singleton mirrored into sessionStorage so a refresh
 * keeps the staff member inside the company they were working. It is NOT a
 * security boundary — RLS is. It only decides which company the console shows
 * and writes to; a staff member is already authorized (via is_platform_admin) to
 * read and, through the widened write policies, write every company.
 */

const KEY = "vendorclr.actingCompanyId";

let actingCompanyId: string | null = null;
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof window === "undefined") return;
  try {
    actingCompanyId = window.sessionStorage.getItem(KEY);
  } catch {
    // Private mode / blocked storage: fall back to in-memory only.
  }
}

/** The company staff are currently acting as, or null when not acting. */
export function getActingCompanyId(): string | null {
  hydrate();
  return actingCompanyId;
}

export function setActingCompanyId(companyId: string | null): void {
  hydrated = true;
  actingCompanyId = companyId;
  if (typeof window === "undefined") return;
  try {
    if (companyId) window.sessionStorage.setItem(KEY, companyId);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Ignore storage failures; the in-memory value still drives this tab.
  }
}
