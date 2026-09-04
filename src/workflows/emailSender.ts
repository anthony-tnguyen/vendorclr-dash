/**
 * Outbound email, server-side only.
 *
 * Two implementations behind one interface, same shape as getRepository()'s
 * demo/live split: when RESEND_API_KEY is set, sends for real through Resend;
 * otherwise logs and returns a "no provider configured" result so the caller
 * can still record the attempt in email_outbox without pretending it was
 * delivered. Never throws for a missing provider - a missing RESEND_API_KEY is
 * a deployment gap, not a reason to fail the request that triggered the email.
 *
 * `fetchImpl` is injectable so the Resend path is unit-testable without a real
 * network call or a real API key.
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  status: "sent" | "failed" | "not_configured";
  providerMessageId: string | null;
  error: string | null;
}

export interface EmailSender {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** VendorClear's default From address until a customer-specific sender is configurable. compliance.vendorclr.com is the subdomain actually verified in Resend (resend.com/domains) - the bare vendorclr.com is not, and every send fails against a domain Resend hasn't verified. */
const FROM_ADDRESS = "VendorClear <onboarding@compliance.vendorclr.com>";

function createResendSender(apiKey: string, fetchImpl: typeof fetch): EmailSender {
  return {
    async send(input) {
      try {
        const response = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: FROM_ADDRESS,
            to: [input.to],
            subject: input.subject,
            html: input.html,
            text: input.text,
          }),
        });

        const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };

        if (!response.ok) {
          return {
            status: "failed",
            providerMessageId: null,
            error: body.message ?? `Resend responded ${response.status}`,
          };
        }

        return { status: "sent", providerMessageId: body.id ?? null, error: null };
      } catch (error) {
        return {
          status: "failed",
          providerMessageId: null,
          error: error instanceof Error ? error.message : "Unknown error sending email",
        };
      }
    },
  };
}

function createStubSender(): EmailSender {
  return {
    async send(input) {
      // Deliberately visible in server logs rather than silent: an admin who
      // clicks "send renewal request" with no RESEND_API_KEY set should see why
      // nothing arrived, not conclude email is broken.
      console.warn(
        `[email stub] RESEND_API_KEY is not set - not sending "${input.subject}" to ${input.to}. ` +
          "Set RESEND_API_KEY to send real email; the request itself still succeeds and the " +
          "magic link is returned directly to the caller.",
      );
      return { status: "not_configured", providerMessageId: null, error: null };
    },
  };
}

export function getEmailSender(fetchImpl: typeof fetch = fetch): EmailSender {
  const apiKey = process.env["RESEND_API_KEY"]?.trim();
  return apiKey ? createResendSender(apiKey, fetchImpl) : createStubSender();
}
