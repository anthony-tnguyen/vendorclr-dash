import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getEmailSender,
  type EmailSender,
  type SendEmailInput,
  type SendEmailResult,
} from "./emailSender";

/**
 * The one gate every Node-side email send goes through: nothing is handed to
 * the email provider for an address public.is_email_suppressed() reports as
 * suppressed for that company (a hard bounce, a spam complaint, or a manual
 * do-not-email - see suppressed_recipients).
 *
 * Fails closed: if the suppression check itself errors, the email is not
 * sent and the result says why. A missed notification is recoverable (it is
 * visible in email_outbox and can be resent); mail to an address that
 * bounced or complained is not.
 *
 * The Deno Edge Functions (send-renewal-reminders, process-document-jobs,
 * compliance-housekeeping) cannot import this module, so each carries the
 * same check against the same SQL function - see their sendUnlessSuppressed().
 * src/tests/suppression-coverage.test.ts fails if any file sends mail without
 * going through one of these.
 */

export type GuardedSendResult =
  SendEmailResult | { status: "suppressed"; providerMessageId: null; error: string };

export async function isRecipientSuppressed(
  supabase: SupabaseClient,
  companyId: string,
  email: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_email_suppressed", {
    p_company_id: companyId,
    p_email: email,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function sendUnlessSuppressed(
  supabase: SupabaseClient,
  companyId: string,
  input: SendEmailInput,
  sender: EmailSender = getEmailSender(),
): Promise<GuardedSendResult> {
  let suppressed: boolean;
  try {
    suppressed = await isRecipientSuppressed(supabase, companyId, input.to);
  } catch (error) {
    return {
      status: "failed",
      providerMessageId: null,
      error: `Not sent: could not verify suppression status (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    };
  }
  if (suppressed) {
    return {
      status: "suppressed",
      providerMessageId: null,
      error: "Not sent: address is suppressed (bounced, complained or marked do-not-email).",
    };
  }
  return sender.send(input);
}

/** email_outbox.status for a send outcome. not_configured stays 'queued' - nothing left the building. */
export function outboxStatusFor(
  result: GuardedSendResult,
): "sent" | "failed" | "queued" | "suppressed" {
  if (result.status === "sent") return "sent";
  if (result.status === "failed") return "failed";
  if (result.status === "suppressed") return "suppressed";
  return "queued";
}
