import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  changeVendorContactRole,
  countVendorLinksByContact,
  createContact,
  findContactByEmail,
  linkContactToVendor,
  listCommunicationHistoryForVendor,
  listContactsForCompany,
  listSuppressedRecipients,
  listVendorContacts,
  unlinkContactFromVendor,
  updateContact,
  type CommunicationHistoryEntry,
} from "@/data/repositories/contactRepository";
import type { SuppressionReason, VendorContactRole } from "@/data/dbTypeAliases";

/**
 * Server functions behind the vendor detail page's Contacts panel and
 * Communication history. Every one runs on the caller's request-scoped
 * client, so RLS (can_write_company for writes) and the schema's
 * cross-tenant triggers (assert_company_matches_contact/_vendor) decide
 * what is allowed; nothing here widens access.
 *
 * The company a contact is created in is always read from the vendor row
 * the caller can see - never taken from the client.
 */

async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

export const CONTACT_ROLES = [
  "operational",
  "broker",
  "secondary",
] as const satisfies readonly VendorContactRole[];

const roleSchema = z.enum(CONTACT_ROLES);
const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address.");
const contactFieldsSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  email: emailSchema,
  phone: z.string().trim().max(50).default(""),
  organization: z.string().trim().max(200).default(""),
});

async function companyIdForVendor(vendorId: string): Promise<string> {
  const supabase = await getRequestScopedClient();
  const { data, error } = await supabase
    .from("vendors")
    .select("company_id")
    .eq("id", vendorId)
    .maybeSingle();
  if (error || !data) throw new Error("Vendor not found.");
  return (data as { company_id: string }).company_id;
}

/** Turns constraint/RLS errors into something a person can act on. */
function friendly(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/contacts_company_email_unique/.test(message)) {
    return new Error("Another contact already uses that email address.");
  }
  if (/vendor_contacts_vendor_id_contact_id_role_key|duplicate key/.test(message)) {
    return new Error("That contact already has this role on this vendor.");
  }
  if (/row-level security|violates .*policy|not authorized/i.test(message)) {
    return new Error("Your role can view contacts but not change them.");
  }
  if (/does not match|does not belong/.test(message)) {
    return new Error("That contact belongs to a different company.");
  }
  return error instanceof Error ? error : new Error(message);
}

// ---------------------------------------------------------------------------
// Read: the Contacts panel
// ---------------------------------------------------------------------------

export interface ContactSuppression {
  reason: SuppressionReason;
  suppressedAt: string;
}

export interface VendorContactView {
  vendorContactId: string;
  contactId: string;
  name: string;
  email: string;
  phone: string;
  organization: string;
  role: VendorContactRole;
  /** Non-null means requests will not be emailed to this address. */
  suppression: ContactSuppression | null;
  /** Distinct vendors this contact is linked to, this one included. */
  linkedVendorCount: number;
}

export interface AddressBookEntry {
  contactId: string;
  name: string;
  email: string;
  organization: string;
  suppression: ContactSuppression | null;
}

export interface VendorContactsPanelData {
  contacts: VendorContactView[];
  /** Company contacts available to link (includes ones already linked here under another role). */
  addressBook: AddressBookEntry[];
}

const ROLE_ORDER: Record<VendorContactRole, number> = { operational: 0, broker: 1, secondary: 2 };

export const getVendorContactsPanel = createServerFn({ method: "GET" })
  .validator(z.object({ vendorId: z.string().uuid() }))
  .handler(async ({ data }): Promise<VendorContactsPanelData> => {
    const companyId = await companyIdForVendor(data.vendorId);
    const [links, addressBook, suppressions] = await Promise.all([
      listVendorContacts(data.vendorId),
      listContactsForCompany(companyId),
      listSuppressedRecipients(companyId),
    ]);
    const suppressionByEmail = new Map(
      suppressions.map((s) => [s.email, { reason: s.reason, suppressedAt: s.suppressed_at }]),
    );
    const suppressionFor = (email: string) =>
      suppressionByEmail.get(email.trim().toLowerCase()) ?? null;
    const counts = await countVendorLinksByContact([...new Set(links.map((l) => l.contactId))]);

    return {
      contacts: links
        .map((link) => ({
          ...link,
          suppression: suppressionFor(link.email),
          linkedVendorCount: counts.get(link.contactId) ?? 1,
        }))
        .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name)),
      addressBook: addressBook.map((c) => ({
        contactId: c.id,
        name: c.name,
        email: c.email,
        organization: c.organization,
        suppression: suppressionFor(c.email),
      })),
    };
  });

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface AddVendorContactResult {
  contactId: string;
  /** true when an existing company contact with this email was linked instead of creating a new one. */
  reusedExisting: boolean;
}

/**
 * Adds a contact to a vendor. If the company already has a contact with
 * this address (e.g. a broker who covers other vendors), that contact is
 * linked as-is - its stored name/agency are not overwritten from this form -
 * so one person stays one row.
 */
export const addVendorContact = createServerFn({ method: "POST" })
  .validator(contactFieldsSchema.extend({ vendorId: z.string().uuid(), role: roleSchema }))
  .handler(async ({ data }): Promise<AddVendorContactResult> => {
    try {
      const companyId = await companyIdForVendor(data.vendorId);
      const existing = await findContactByEmail(companyId, data.email);
      const contact =
        existing ??
        (await createContact({
          companyId,
          name: data.name,
          email: data.email,
          phone: data.phone,
          organization: data.organization,
        }));
      await linkContactToVendor({
        companyId,
        vendorId: data.vendorId,
        contactId: contact.id,
        role: data.role,
      });
      return { contactId: contact.id, reusedExisting: existing !== null };
    } catch (error) {
      throw friendly(error);
    }
  });

export const linkExistingContact = createServerFn({ method: "POST" })
  .validator(
    z.object({ vendorId: z.string().uuid(), contactId: z.string().uuid(), role: roleSchema }),
  )
  .handler(async ({ data }): Promise<{ vendorContactId: string }> => {
    try {
      const companyId = await companyIdForVendor(data.vendorId);
      const row = await linkContactToVendor({
        companyId,
        vendorId: data.vendorId,
        contactId: data.contactId,
        role: data.role,
      });
      return { vendorContactId: row.id };
    } catch (error) {
      throw friendly(error);
    }
  });

export const editContact = createServerFn({ method: "POST" })
  .validator(contactFieldsSchema.extend({ contactId: z.string().uuid() }))
  .handler(async ({ data }): Promise<{ contactId: string }> => {
    try {
      const row = await updateContact({
        contactId: data.contactId,
        name: data.name,
        email: data.email,
        phone: data.phone,
        organization: data.organization,
      });
      return { contactId: row.id };
    } catch (error) {
      throw friendly(error);
    }
  });

export const changeContactRole = createServerFn({ method: "POST" })
  .validator(z.object({ vendorContactId: z.string().uuid(), role: roleSchema }))
  .handler(async ({ data }): Promise<{ vendorContactId: string }> => {
    try {
      const row = await changeVendorContactRole(data.vendorContactId, data.role);
      return { vendorContactId: row.id };
    } catch (error) {
      throw friendly(error);
    }
  });

export const unlinkVendorContact = createServerFn({ method: "POST" })
  .validator(z.object({ vendorContactId: z.string().uuid() }))
  .handler(async ({ data }): Promise<{ status: "unlinked" }> => {
    try {
      const supabase = await getRequestScopedClient();
      // RLS makes a delete the caller may not perform a silent no-op; check
      // the row is gone so a read-only member gets a real error.
      await unlinkContactFromVendor(data.vendorContactId);
      const { data: still } = await supabase
        .from("vendor_contacts")
        .select("id")
        .eq("id", data.vendorContactId)
        .maybeSingle();
      if (still) throw new Error("not authorized");
      return { status: "unlinked" };
    } catch (error) {
      throw friendly(error);
    }
  });

/**
 * Manual do-not-email on/off. Bounces and complaints are recorded
 * automatically (handle_bounce_suppression()); this lets someone suppress an
 * address the provider never reported, or clear one once the address is
 * confirmed fixed. Both are audited (record_contact_audit()).
 */
export const setRecipientSuppression = createServerFn({ method: "POST" })
  .validator(z.object({ vendorId: z.string().uuid(), email: emailSchema, suppressed: z.boolean() }))
  .handler(async ({ data }): Promise<{ suppressed: boolean }> => {
    try {
      const companyId = await companyIdForVendor(data.vendorId);
      const supabase = await getRequestScopedClient();
      const email = data.email.trim().toLowerCase();
      if (data.suppressed) {
        const { error } = await supabase
          .from("suppressed_recipients")
          .upsert(
            { company_id: companyId, email, reason: "manual" },
            { onConflict: "company_id,email", ignoreDuplicates: true },
          );
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase
          .from("suppressed_recipients")
          .delete()
          .eq("company_id", companyId)
          .eq("email", email);
        if (error) throw new Error(error.message);
      }
      const { data: check, error: checkError } = await supabase.rpc("is_email_suppressed", {
        p_company_id: companyId,
        p_email: email,
      });
      if (checkError) throw new Error(checkError.message);
      if (check !== data.suppressed) throw new Error("not authorized");
      return { suppressed: check === true };
    } catch (error) {
      throw friendly(error);
    }
  });

// ---------------------------------------------------------------------------
// Communication history
// ---------------------------------------------------------------------------

export interface CommunicationHistoryRow {
  outboxId: string;
  createdAt: string;
  recipientEmail: string;
  recipientName: string | null;
  contactId: string | null;
  role: VendorContactRole | null;
  template: string;
  /** vendor_upload_requests.purpose when the email carried an upload link. */
  requestPurpose: string | null;
  requestId: string | null;
  requestStatus: string | null;
  status: string;
  sent: boolean;
  delivered: boolean;
  bounced: boolean;
  complained: boolean;
  failed: boolean;
  suppressed: boolean;
  uploadReceived: boolean;
  error: string | null;
  /** Email + link to a contact: may be resent to an edited recipient list. */
  canResend: boolean;
}

const UPLOAD_RECEIVED_STATUSES = new Set(["uploaded", "processing", "completed", "needs_review"]);
const RESENDABLE_TEMPLATES = new Set(["renewal_request", "renewal_reminder", "vendor_onboarding"]);

export function toHistoryRow(entry: CommunicationHistoryEntry): CommunicationHistoryRow {
  const { outbox, events, request } = entry;
  const eventTypes = new Set(events.map((e) => e.event_type));
  const status = outbox.status;
  const sent =
    status === "sent" ||
    status === "delivered" ||
    status === "bounced" ||
    status === "complained" ||
    eventTypes.has("sent");
  return {
    outboxId: outbox.id,
    createdAt: outbox.created_at,
    recipientEmail: outbox.to_email,
    recipientName: entry.contactName,
    contactId: outbox.contact_id,
    role: outbox.recipient_role,
    template: outbox.template,
    requestPurpose: request?.purpose ?? null,
    requestId: request?.id ?? null,
    requestStatus: request?.status ?? null,
    status,
    sent,
    delivered: status === "delivered" || eventTypes.has("delivered"),
    bounced: status === "bounced" || eventTypes.has("bounced"),
    complained: status === "complained" || eventTypes.has("complained"),
    failed: status === "failed",
    suppressed: status === "suppressed",
    uploadReceived: Boolean(
      request && (request.uploaded_at || UPLOAD_RECEIVED_STATUSES.has(request.status)),
    ),
    error: outbox.error,
    canResend: Boolean(request) && RESENDABLE_TEMPLATES.has(outbox.template),
  };
}

export const getCommunicationHistory = createServerFn({ method: "GET" })
  .validator(z.object({ vendorId: z.string().uuid() }))
  .handler(async ({ data }): Promise<CommunicationHistoryRow[]> => {
    const entries = await listCommunicationHistoryForVendor(data.vendorId);
    return entries.map(toHistoryRow);
  });
