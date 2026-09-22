import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * /terms and /privacy.
 *
 * No counsel-approved legal text exists for VendorClr yet. These pages
 * therefore contain only factual, technical descriptions of what the product
 * does today - each traceable to code or to docs/legal/subprocessors.md - and
 * mark every section that would carry a legal commitment (retention periods,
 * warranties, liability, SLAs, DPA terms, deletion schedules, certifications)
 * as "Pending legal/product approval" instead of inventing one. Replace a
 * pending section only with approved language.
 */

export const PENDING_APPROVAL = "Pending legal/product approval";

/** Links to the legal pages, for the auth screens, the vendor portal and the console sidebar. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={className ?? "flex gap-3 text-xs text-muted-foreground"}>
      <Link to="/terms" className="focusable underline underline-offset-2">
        Terms
      </Link>
      <Link to="/privacy" className="focusable underline underline-offset-2">
        Privacy
      </Link>
    </nav>
  );
}

function Pending() {
  return (
    <p className="mt-2 rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-semibold text-warn">
      {PENDING_APPROVAL}. No commitment is made in this section yet.
    </p>
  );
}

function Section({
  title,
  pending,
  children,
}: {
  title: string;
  pending?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-5">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children ? (
        <div className="mt-2 space-y-2 text-sm leading-6 text-foreground">{children}</div>
      ) : null}
      {pending ? <Pending /> : null}
    </section>
  );
}

function LegalLayout({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <main className="mx-auto w-full max-w-2xl">
        <Link to="/" className="focusable inline-block" aria-label="VendorClr home">
          <img src="/vendorclr-logo-black.svg" alt="VendorClr" className="h-5 w-auto" />
        </Link>
        <article className="mt-4 rounded-md border border-border bg-card p-6">
          <h1 className="text-xl font-bold tracking-tight text-foreground">{title}</h1>
          <p
            role="note"
            className="mt-3 rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-foreground"
          >
            <strong>Draft — {PENDING_APPROVAL}.</strong> {intro}
          </p>
          <div className="mt-6 space-y-6">{children}</div>
        </article>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <LegalLinks />
          <Link to="/login" className="focusable text-xs text-muted-foreground underline">
            Back to sign in
          </Link>
        </div>
      </main>
    </div>
  );
}

export function TermsPage() {
  return (
    <LegalLayout
      title="Terms of Service"
      intro="Binding terms for VendorClr have not been approved or published. This page describes how the service works today so you know what it does; it is not a contract and creates no obligations."
    >
      <Section title="What VendorClr does">
        <p>
          VendorClr helps construction companies collect and track their subcontractors' and
          vendors' certificates of insurance. A company invites vendors to upload documents through
          a secure link, VendorClr reads the coverage details from each document, and compares them
          with the insurance requirements the company has configured for each project.
        </p>
        <p>
          Reading a document is automated and can be wrong. Documents that cannot be processed
          confidently go to a manual review queue, and compliance status is calculated from the
          company's configured requirements rather than from the automated reading's own confidence.
        </p>
      </Section>
      <Section title="Accounts and access">
        <p>
          A company workspace is opened with an activation code issued by VendorClr. Within a
          workspace, members hold one of four roles: owner, risk manager, project engineer or
          read-only. Read-only members can view but not change data. Vendors do not need an account;
          they use a time-limited secure link sent to them.
        </p>
      </Section>
      <Section title="Your responsibilities and acceptable use" pending />
      <Section title="Fees, billing and renewal" pending />
      <Section title="Warranties and disclaimers" pending />
      <Section title="Limitation of liability" pending />
      <Section title="Service availability and support" pending />
      <Section title="Suspension and termination" pending />
      <Section title="Governing law and disputes" pending />
      <Section title="Changes to these terms" pending />
      <Section title="Contact" pending />
    </LegalLayout>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy Notice"
      intro="An approved privacy policy has not been published. This page factually describes what data the product handles and which services it uses today. It makes no promises about retention, deletion timelines, or contractual data-protection terms."
    >
      <Section title="Information the product handles">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Account details</strong> — the name and email address used to sign in, and the
            company and role a member belongs to.
          </li>
          <li>
            <strong>Company records</strong> — projects, vendors, vendor contacts (names, email
            addresses, organization), insurance requirements, and the compliance results calculated
            from them.
          </li>
          <li>
            <strong>Uploaded documents</strong> — certificates of insurance and related files that
            vendors upload, and the coverage details read from them.
          </li>
          <li>
            <strong>Email delivery records</strong> — which request and reminder emails were sent,
            and whether they were delivered, bounced or marked as spam. Addresses that bounce or
            complain stop receiving email from VendorClr.
          </li>
          <li>
            <strong>Activity history</strong> — an audit log of actions such as requests sent,
            reviews decided, imports run and reports exported, with the member who took them.
          </li>
          <li>
            <strong>Upload protection</strong> — to limit abuse of vendor upload links, the
            uploader's IP address is used in keyed-hash form for rate limiting.
          </li>
        </ul>
      </Section>
      <Section title="Services that process this information">
        <p>
          The following providers receive data when the corresponding feature is configured. This
          list is taken from the product's own integrations.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Supabase</strong> — database, private document storage and sign-in.
          </li>
          <li>
            <strong>Anthropic</strong> — reads the contents of uploaded insurance documents to
            extract coverage details.
          </li>
          <li>
            <strong>Resend</strong> — sends email to vendors and members, and reports delivery
            status.
          </li>
          <li>
            <strong>VirusTotal</strong> — receives a fingerprint (hash) of each uploaded file for a
            malware lookup, not the file itself.
          </li>
          <li>
            <strong>Cloudflare</strong> — hosts the application; all requests pass through it.
          </li>
          <li>
            <strong>Sentry</strong> — receives error reports when error tracking is enabled.
          </li>
        </ul>
      </Section>
      <Section title="Cookies and browser storage">
        <p>Signing in stores a session in browser cookies so you stay signed in.</p>
      </Section>
      <Section title="Who can see company data">
        <p>
          Each company's data is separated at the database level so that members only see their own
          company's records. Vendors see only the request they were sent. VendorClr staff can access
          customer data to review documents and operate the service.
        </p>
      </Section>
      <Section title="Data retention" pending />
      <Section title="Export and deletion requests">
        <p>
          Tooling exists for VendorClr staff to export a company's data and to delete a company's
          data. How requests are made, and the timelines for handling them, are not yet approved.
        </p>
      </Section>
      <Section title="Your privacy rights" pending />
      <Section title="International data transfers" pending />
      <Section title="Data processing agreements" pending />
      <Section title="Security" pending />
      <Section title="Changes to this notice" pending />
      <Section title="Contact" pending />
    </LegalLayout>
  );
}
