import { AppShell } from "@/components/shell/AppShell";

/**
 * Static help / FAQ content, shared by the customer and administrator nav.
 *
 * No backend calls and no demo/live branching - every answer below describes
 * behavior that's actually live (see AppShell's footer), so it's accurate in
 * both modes without needing to know which one is running.
 */

interface FaqEntry {
  question: string;
  answer: string;
}

interface FaqSection {
  title: string;
  entries: FaqEntry[];
}

const sections: FaqSection[] = [
  {
    title: "Vendor certificates & uploads",
    entries: [
      {
        question: "How does a vendor upload their insurance certificate?",
        answer:
          "From a vendor's detail page, request an updated certificate. That generates a unique, single-use upload link that needs no login, which you send to the vendor. Opening it shows them what's currently on file and lets them upload a new certificate.",
      },
      {
        question: "What file types and size are accepted?",
        answer: "PDF, JPG or PNG, up to 25MB.",
      },
      {
        question: "What happens right after a vendor uploads a document?",
        answer:
          "It's scanned, then read automatically to pull out the carrier, policy number, coverage limits and dates. The first submission on file for a given coverage type is routed to the compliance queue for a quick human review before it's applied to the vendor's record; matching resubmissions after that can apply automatically.",
      },
    ],
  },
  {
    title: "Compliance status",
    entries: [
      {
        question: "What do the status labels mean?",
        answer:
          "Compliant: coverage on file meets requirements and hasn't expired. Expiring: still valid, but inside the renewal window. Missing: no policy on file for this requirement. Expired: coverage on file has lapsed. In review: a submitted document is waiting on a compliance queue decision.",
      },
      {
        question: "What requirement types are tracked per vendor?",
        answer:
          "Five: Certificate of Insurance (COI), Additional Insured, Waiver of Subrogation, Lien Waiver, and Renewal.",
      },
    ],
  },
  {
    title: "Renewal reminders",
    entries: [
      {
        question: "Are renewal reminders automatic?",
        answer:
          "Yes. About 30 days before an active vendor's policy expires, VendorClr emails their contact a fresh upload link automatically - no action needed from you.",
      },
      {
        question: "Can I control when reminders go out?",
        answer:
          "Not yet - reminders currently fire on a fixed 30-day-before-expiration schedule for every active vendor.",
      },
    ],
  },
  {
    title: "Roles & access",
    entries: [
      {
        question: "What can each role do?",
        answer:
          "Owner: full access, including inviting teammates and managing scope. Risk Manager: manages vendors, requirements and reviews. Project Engineer: views and works vendor/compliance data for their projects. Read only: can view everything, can't make changes.",
      },
      {
        question: "Does switching to the administrator view change what data I can see?",
        answer:
          "No - it only changes which console you see, not what the database returns. Access is enforced by row-level security regardless of which view is open.",
      },
    ],
  },
];

export function HelpPage() {
  return (
    <AppShell title="Help & FAQ" subtitle="How VendorClr works, answered.">
      <div className="space-y-6">
        {sections.map((section) => (
          <section key={section.title} className="rounded-md border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
            <div className="mt-3 divide-y divide-border">
              {section.entries.map((entry) => (
                <details key={entry.question} className="group py-3 first:pt-0 last:pb-0">
                  <summary className="focusable cursor-pointer list-none text-sm font-medium text-foreground marker:content-none">
                    <span className="mr-2 inline-block text-muted-foreground transition-transform group-open:rotate-90">
                      ›
                    </span>
                    {entry.question}
                  </summary>
                  <p className="mt-2 pl-4 text-sm text-muted-foreground">{entry.answer}</p>
                </details>
              ))}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
