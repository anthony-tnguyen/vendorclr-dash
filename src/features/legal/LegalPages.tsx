import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import logoAsset from "@/assets/vendorclr-logo.svg.asset.json";

/**
 * /terms and /privacy.
 *
 * Interim text, written before attorney review. Every factual statement about
 * how the product works is traceable to code or to docs/legal/subprocessors.md -
 * see docs/legal/interim-terms-notes.md for the claim-by-claim evidence and for
 * the items a lawyer should look at first. Do not add a commitment here (a
 * retention period, an uptime figure, a certification, a breach-notice deadline)
 * that the product does not actually enforce: an unmet promise is worse than none.
 */

export const OPERATOR_NAME = "Anjeko Holdings LLC";
export const OPERATOR_DESCRIPTION = "a California limited liability company";
export const CONTACT_EMAIL = "support@vendorclr.com";
export const EFFECTIVE_DATE = "September 24, 2026";

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

/**
 * Assent line shown beside the action that creates the agreement (creating an
 * account, accepting an invitation, activating a workspace, uploading as a
 * vendor). Terms linked only from a footer are weak evidence anyone agreed to
 * them; stating the agreement at the point of action is what makes them binding.
 */
export function LegalConsent({
  action,
  note,
  className,
}: {
  action: string;
  note?: string;
  className?: string;
}) {
  return (
    <p className={className ?? "text-xs leading-5 text-muted-foreground"}>
      By {action}, you agree to the{" "}
      <Link to="/terms" className="focusable underline underline-offset-2">
        Terms of Service
      </Link>{" "}
      and acknowledge the{" "}
      <Link to="/privacy" className="focusable underline underline-offset-2">
        Privacy Notice
      </Link>
      .{note ? ` ${note}` : null}
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border pt-5">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-6 text-foreground">{children}</div>
    </section>
  );
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <main className="mx-auto w-full max-w-2xl">
        <Link to="/" className="focusable inline-block" aria-label="VendorClr home">
          <img src={logoAsset.url} alt="VendorClr" className="h-5 w-auto" />
        </Link>
        <article className="mt-4 rounded-md border border-border bg-card p-6">
          <h1 className="text-xl font-bold tracking-tight text-foreground">{title}</h1>
          <p role="note" className="mt-2 text-xs text-muted-foreground">
            Effective {EFFECTIVE_DATE}
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
    <LegalLayout title="Terms of Service">
      <Section title="1. Agreement">
        <p>
          These Terms of Service are an agreement between {OPERATOR_NAME}, {OPERATOR_DESCRIPTION}{" "}
          (&ldquo;VendorClr,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;), and the business or person
          using the service (&ldquo;you&rdquo;). By creating an account, accepting an invitation,
          activating a workspace, uploading a document through a secure link, or otherwise using
          VendorClr, you agree to these Terms and acknowledge the Privacy Notice. If you use
          VendorClr on behalf of a company, you confirm you have authority to bind that company, and
          &ldquo;you&rdquo; includes it. If you do not agree, do not use VendorClr.
        </p>
        <p>
          VendorClr is for business use by adults. It is not offered to consumers or to anyone under
          18. If you have a separate written agreement signed by VendorClr, that agreement controls
          wherever it conflicts with these Terms.
        </p>
      </Section>

      <Section title="2. What VendorClr does, and what it does not">
        <p>
          VendorClr helps construction companies collect and track their subcontractors&rsquo; and
          vendors&rsquo; certificates of insurance. A company invites vendors to upload documents
          through a secure link, VendorClr reads the coverage details from each document, and
          compares them with the insurance requirements the company has configured for each project.
        </p>
        <p>
          <strong>
            VendorClr is a record-keeping and workflow tool. It is not an insurance agent, broker,
            carrier or adjuster, a law firm, or a risk or safety consultant, and it gives no
            insurance, legal or contractual advice.
          </strong>{" "}
          In particular:
        </p>
        <Bullets>
          <li>
            A certificate of insurance is an informational document. VendorClr does not confirm a
            certificate with the insurer or agent, does not verify that a policy is genuine or in
            force, and does not confirm that a policy will respond to any claim.
          </li>
          <li>
            A status such as &ldquo;compliant&rdquo; means only that the information read from the
            documents met the requirements the company configured. It does not mean a vendor is
            adequately insured, that a loss will be covered, or that the company satisfies any
            contract, law, lender, owner or insurer requirement.
          </li>
          <li>
            Reading documents is automated and can be wrong or incomplete. You are responsible for
            confirming anything you rely on against the original document, and for the decisions you
            make with it, including whether to allow a vendor onto a project.
          </li>
        </Bullets>
      </Section>

      <Section title="3. Accounts, workspaces and access">
        <p>
          A company workspace is opened with an activation code issued by VendorClr. Within a
          workspace, members hold one of four roles: owner, risk manager, project engineer or
          read-only. Owners control who has access. You are responsible for the accuracy of the
          information you provide, for keeping credentials confidential, for everything done under
          your account, and for promptly removing people who should no longer have access. Tell us
          at once if you suspect unauthorized use.
        </p>
      </Section>

      <Section title="4. Vendors and secure links">
        <p>
          Vendors do not need an account; they use a time-limited secure link sent to them by a
          company. If you upload through a secure link, you confirm that you are authorized to share
          the documents, that they are genuine and unaltered, and that they contain no malware. The
          documents and details you provide are shared with the company that sent the link, which
          decides how they are used. VendorClr provides the service to that company and does not
          decide whether a vendor is acceptable. Questions about a request should go to the company
          that sent it.
        </p>
      </Section>

      <Section title="5. Your data and our license to it">
        <p>
          As between you and VendorClr, you own the information, documents and records you or your
          vendors put into the service (&ldquo;Customer Data&rdquo;). You give VendorClr a
          non-exclusive license to host, copy, process, transmit and display Customer Data only as
          needed to provide, secure, support and improve the reliability of the service, to comply
          with law, and as these Terms and the Privacy Notice describe. VendorClr does not use
          Customer Data to train artificial-intelligence models.
        </p>
        <p>
          You are responsible for having the rights and permissions needed to put Customer Data into
          the service, including any notice to, or consent from, your vendors and their contacts.
          VendorClr and its licensors own the service, its software and its design. If you send
          feedback, we may use it without restriction or payment.
        </p>
      </Section>

      <Section title="6. Your responsibilities and acceptable use">
        <p>You agree not to, and not to let anyone else:</p>
        <Bullets>
          <li>use the service unlawfully, or to infringe or violate anyone&rsquo;s rights;</li>
          <li>upload malware, or content you are not permitted to share;</li>
          <li>
            probe, scan or test the service&rsquo;s security, bypass its access controls, rate
            limits or abuse protections, or access data that is not yours;
          </li>
          <li>
            scrape, copy, resell or reverse engineer the service, or use it to build a competing
            product;
          </li>
          <li>
            send secure links to, or contact, people in a way that is harassing, deceptive or
            unlawful, or interfere with the service or other users.
          </li>
        </Bullets>
        <p>
          You are responsible for configuring your insurance requirements, for the accuracy of your
          own records, and for complying with the laws and contracts that apply to your business.
        </p>
      </Section>

      <Section title="7. AI-assisted document reading">
        <p>
          VendorClr uses a third-party AI service to read uploaded documents and extract coverage
          details. Output may be inaccurate, incomplete or missing. Documents that cannot be
          processed confidently go to a manual review queue, and compliance status is calculated
          from your configured requirements rather than from the reading&rsquo;s own confidence.
          These safeguards reduce, but do not eliminate, errors. See section 2 and section 10.
        </p>
      </Section>

      <Section title="8. Fees, billing and renewal">
        <p>
          Your plan, fees and renewal date are set when your workspace is activated and are stated
          in your order, invoice or written agreement with VendorClr. Unless that document says
          otherwise, fees are due as invoiced, are non-refundable except where the law requires
          otherwise, and exclude taxes, which you are responsible for. We may change fees for a
          future term by giving notice before that term begins.
        </p>
      </Section>

      <Section title="9. Third-party services">
        <p>
          The service relies on third-party providers, listed in the Privacy Notice. We are not
          responsible for their acts or omissions, and the service may be affected by outages or
          changes at those providers.
        </p>
      </Section>

      <Section title="10. Disclaimer of warranties">
        <p className="uppercase">
          The service is provided &ldquo;as is&rdquo; and &ldquo;as available.&rdquo; To the fullest
          extent the law allows, VendorClr disclaims all warranties, express or implied, including
          warranties of merchantability, fitness for a particular purpose, title and
          non-infringement. VendorClr does not warrant that the service will be uninterrupted,
          secure or error-free; that extracted information, compliance statuses or reports will be
          accurate or complete; that any certificate or policy is genuine or in force; or that using
          the service will make you or your vendors compliant with any contract or law, or reduce
          your risk of loss or claims.
        </p>
      </Section>

      <Section title="11. Limitation of liability">
        <p className="uppercase">
          To the fullest extent the law allows: (a) VendorClr will not be liable for any indirect,
          incidental, special, consequential, exemplary or punitive damages, or for lost profits,
          revenue, business, goodwill or data, or for losses arising from a claim that is uninsured
          or denied, from a vendor&rsquo;s lack of coverage or non-compliance, or from your reliance
          on information in the service, even if advised of the possibility; and (b)
          VendorClr&rsquo;s total liability for all claims arising out of or relating to the service
          or these Terms will not exceed the greater of the fees you paid to VendorClr for the
          service in the twelve months before the event giving rise to the claim, and one hundred US
          dollars ($100).
        </p>
        <p>
          Nothing in these Terms excludes or limits liability for fraud, gross negligence or willful
          misconduct, or any liability that cannot be excluded or limited under applicable law. Some
          jurisdictions do not allow certain limitations, so parts of this section may not apply to
          you. The limits in this section apply regardless of the legal theory of the claim and are
          a basic part of the bargain reflected in the fees.
        </p>
      </Section>

      <Section title="12. Indemnification">
        <p>
          You will defend and indemnify VendorClr, its owners, officers, employees and contractors
          against third-party claims, and resulting losses, damages, costs and reasonable
          attorneys&rsquo; fees, arising from your Customer Data, from your use of the service in
          breach of these Terms or the law, or from decisions you make about vendors, projects or
          coverage. We will tell you promptly of a claim, let you control its defense (though we may
          take part with our own counsel at our own cost), and you may not settle it in a way that
          admits fault for VendorClr without our written consent.
        </p>
      </Section>

      <Section title="13. Service availability and support">
        <p>
          We work to keep the service available but make no uptime, response-time or support
          commitment, and we may change, limit or discontinue features, or perform maintenance, at
          any time. Support is provided by email at{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>{" "}
          on a reasonable-efforts basis. You are responsible for keeping your own copies of records
          you cannot afford to lose.
        </p>
      </Section>

      <Section title="14. Suspension and termination">
        <p>
          You may stop using VendorClr at any time. We may suspend or end access, in whole or in
          part, if you breach these Terms, fail to pay, or use the service in a way that creates
          security, legal or operational risk, or if we stop offering the service. When a workspace
          is closed or ends, access stops. Customer Data is then handled as the Privacy Notice
          describes, and you may ask us to export it. Sections that by their nature should survive
          termination, including sections 5, 10, 11, 12, 14 and 15 to 17, will survive.
        </p>
      </Section>

      <Section title="15. Governing law and disputes">
        <p>
          These Terms are governed by California law, without regard to its conflict-of-laws rules.
          Before filing a claim, each party will first try to resolve the dispute informally by
          written notice to the other, and will allow 30 days for that. Any claim that is not
          resolved must be brought exclusively in the state or federal courts located in California,
          and each party consents to their jurisdiction and venue. Either party may seek an
          injunction in any court of competent jurisdiction to protect its intellectual property or
          confidential information.
        </p>
      </Section>

      <Section title="16. Changes to these terms">
        <p>
          We may update these Terms. The effective date above shows when they last changed. For
          material changes we will notify workspace owners by email or in the service before the
          change takes effect where practical. If you keep using the service after a change takes
          effect, you accept the updated Terms.
        </p>
      </Section>

      <Section title="17. General">
        <p>
          These Terms and the Privacy Notice are the entire agreement between you and VendorClr
          about the service and replace earlier understandings about it. If part of these Terms is
          unenforceable, the rest remains in effect. A failure to enforce a right is not a waiver.
          You may not assign these Terms without our written consent; we may assign them in a
          merger, acquisition or sale of assets. Neither party is liable for delay or failure caused
          by events beyond its reasonable control. You will comply with export-control and sanctions
          laws that apply to your use. You agree that we may give notices by email or through the
          service, and that electronic records and signatures are valid.
        </p>
      </Section>

      <Section title="18. Contact">
        <p>
          {OPERATOR_NAME}. Questions, notices and requests:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </LegalLayout>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Notice">
      <Section title="Who we are and our role">
        <p>
          {OPERATOR_NAME}, {OPERATOR_DESCRIPTION}, operates VendorClr. This notice explains what
          information the service handles and how.
        </p>
        <p>
          For records that a company and its vendors put into VendorClr (vendors, contacts,
          documents, requirements and results), the company decides what is collected and why, and
          VendorClr processes that information on the company&rsquo;s behalf as its service
          provider. If you are a vendor or vendor contact and have a question about your information
          in a company&rsquo;s workspace, that company is the right first contact, and we will help
          it respond. For account, security and service-operation information, VendorClr decides how
          it is used.
        </p>
      </Section>

      <Section title="Information the product handles">
        <Bullets>
          <li>
            <strong>Account details</strong> — the name and email address used to sign in, a
            password (stored by our authentication provider, never in readable form), and the
            company and role a member belongs to.
          </li>
          <li>
            <strong>Company records</strong> — projects, vendors, vendor contacts (names, email
            addresses, organization), insurance requirements, and the compliance results calculated
            from them.
          </li>
          <li>
            <strong>Uploaded documents</strong> — certificates of insurance and related files that
            vendors upload, and the coverage details read from them. These can contain names,
            business addresses and policy numbers.
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
            <strong>Technical and security data</strong> — request and error logs, and the
            uploader&rsquo;s IP address, which is used in keyed-hash form (not stored in readable
            form) to rate-limit vendor upload links and limit abuse. Our hosting provider also sees
            IP addresses as part of serving requests.
          </li>
        </Bullets>
        <p>
          We do not knowingly collect information from children, and the service is not directed to
          anyone under 18.
        </p>
      </Section>

      <Section title="How we use it">
        <Bullets>
          <li>
            to provide the service: store records, read documents, calculate compliance results,
            send requests and reminders, and produce reports and exports;
          </li>
          <li>to keep the service secure, prevent abuse and fraud, and troubleshoot errors;</li>
          <li>to communicate with you about your account, the service and support requests;</li>
          <li>to comply with the law and enforce our Terms.</li>
        </Bullets>
        <p>
          <strong>
            We do not sell personal information, and we do not share it for cross-context behavioral
            advertising.
          </strong>{" "}
          The service uses no third-party advertising or analytics trackers.
        </p>
      </Section>

      <Section title="AI document reading">
        <p>
          When a document is uploaded, its contents are sent to Anthropic&rsquo;s API to extract
          coverage details. VendorClr does not use uploaded documents to train AI models. Results
          can be wrong; see the Terms of Service.
        </p>
      </Section>

      <Section title="Services that process this information">
        <p>
          The following providers receive data when the corresponding feature is in use. This list
          is taken from the product&rsquo;s own integrations.
        </p>
        <Bullets>
          <li>
            <strong>Supabase</strong> — database, private document storage and sign-in. The project
            is hosted in the United States.
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
            <strong>Cloudflare</strong> — hosts the application, so requests pass through it. Its
            Turnstile check may also be shown to visitors to the vendor upload page to tell people
            from automated traffic.
          </li>
          <li>
            <strong>Sentry</strong> — receives error reports when error tracking is enabled.
          </li>
        </Bullets>
        <p>
          We may also disclose information to your own company&rsquo;s members as their role allows;
          to the company that sent a vendor a secure link; to professional advisers; when required
          by law or to protect rights, safety or security; and to a successor in a merger,
          acquisition or sale of assets. Other than that, we do not disclose it.
        </p>
      </Section>

      <Section title="Cookies and browser storage">
        <p>
          Signing in stores a session in browser cookies so you stay signed in. The service sets no
          advertising or analytics cookies. Cloudflare Turnstile, when shown, may use its own
          storage to do its check. We do not respond to browser Do Not Track signals, because the
          service does not track you across other sites.
        </p>
      </Section>

      <Section title="Who can see company data">
        <p>
          Each company&rsquo;s data is separated at the database level so that members only see
          their own company&rsquo;s records. Vendors see only the request they were sent. VendorClr
          staff can access customer data to review documents, support customers and operate the
          service.
        </p>
      </Section>

      <Section title="Data retention">
        <p>
          We keep a company&rsquo;s data while its workspace is active. After a workspace is closed
          or ends, we keep it for a reasonable period so that it can be exported or reactivated, and
          to resolve disputes, enforce our agreements and meet legal obligations, and then delete
          it. We choose retention by the type of record and these purposes; some records, such as
          the audit log and email suppression list, may be kept longer where needed for them. We do
          not currently delete data automatically on a fixed schedule: deletion happens when a
          customer asks or when we complete a deletion process. Copies held in our providers&rsquo;
          backups are overwritten on the providers&rsquo; own schedules.
        </p>
      </Section>

      <Section title="Your choices and rights">
        <p>
          You can ask us to export or delete your information, or to correct it, by emailing{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
          . We may need to verify your identity, and for records that belong to a company&rsquo;s
          workspace we may refer you to that company or act on its instructions. We will respond
          within the time the law requires and will not treat you differently for making a request.
        </p>
        <p>
          <strong>California residents</strong> have the right to know what personal information we
          collect, use and disclose; to delete it and to correct it; to opt out of the sale or
          sharing of personal information (we do neither); and to limit the use of sensitive
          personal information (we do not use it for purposes that require this). You may use an
          authorized agent to make a request. We have not sold or shared personal information in the
          past twelve months. Residents of other states may have similar rights, and you can use the
          same address.
        </p>
      </Section>

      <Section title="Security">
        <p>
          We use reasonable administrative and technical measures to protect information, including
          separating each company&rsquo;s data at the database level, keeping uploaded documents in
          private storage, using encrypted connections, hashing IP addresses used for rate limiting,
          and restricting staff access to authorized administrators. We also rely on the security of
          our hosting providers. No system is completely secure, and we cannot guarantee the
          security of information. If a breach affects your information, we will notify you as the
          law requires.
        </p>
      </Section>

      <Section title="International use">
        <p>
          VendorClr is operated from the United States and its data is processed and stored there
          and wherever our providers operate. If you use the service from elsewhere, you understand
          your information will be transferred to and processed in the United States.
        </p>
      </Section>

      <Section title="Data processing agreements">
        <p>
          If your company needs a signed data-processing agreement, contact us. Until one is signed,
          the Terms of Service and this notice govern our handling of information.
        </p>
      </Section>

      <Section title="Changes to this notice">
        <p>
          We may update this notice. The effective date above shows when it last changed. For
          material changes we will notify workspace owners by email or in the service where
          practical.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          {OPERATOR_NAME}.{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </LegalLayout>
  );
}
