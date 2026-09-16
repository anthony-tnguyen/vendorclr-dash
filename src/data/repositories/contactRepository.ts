import type {
  ContactRow,
  EmailDeliveryEventRow,
  EmailOutboxRow,
  SuppressedRecipientRow,
  VendorContactRole,
  VendorContactRow,
} from "@/data/dbTypeAliases";

/**
 * Read/write repository over contacts / vendor_contacts / suppressed_recipients
 * (Task 7 - supabase/migrations/20260916000600_contacts_and_suppression.sql),
 * plus the email_outbox + email_delivery_events join a future
 * CommunicationHistory.tsx needs to show queued/sent/delivered/delayed/
 * bounced/complained/failed history per vendor.
 *
 * Same shape and conventions as requirementRepository.ts/projectRepository.ts:
 * request-scoped client, thin typed wrappers, no business logic - the
 * suppression check and email-sending logic itself lives in
 * src/workflows/communications.ts, not here. This file is deliberately
 * reusable by both sendRequest() and a future ContactsPanel.tsx/
 * CommunicationHistory.tsx without either needing to know Supabase's raw
 * column shapes.
 */
async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data and no error");
  return result.data;
}

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------

/** Every contact in a company's address book, alphabetical - the source list a future ContactsPanel picks from when linking a contact to a vendor. */
export async function listContactsForCompany(companyId: string): Promise<ContactRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("contacts")
    .select("*")
    .eq("company_id", companyId)
    .order("name", { ascending: true })) as unknown as {
    data: ContactRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

export interface CreateContactInput {
  companyId: string;
  name: string;
  email: string;
  phone?: string;
  notes?: string;
}

/**
 * Creates a standalone contact, not yet linked to any vendor. Deliberately
 * takes plain fields rather than a vendor to pre-fill from: a future UI can
 * call this with vendors.contact_name/contact_email to seed a vendor's
 * first "operational" contact from the Phase 0-era columns, then
 * linkContactToVendor() the result - this function itself does not read
 * those columns, so it works identically for any other contact creation
 * path too.
 */
export async function createContact(input: CreateContactInput): Promise<ContactRow> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("contacts")
    .insert({
      company_id: input.companyId,
      name: input.name,
      email: input.email,
      phone: input.phone ?? "",
      notes: input.notes ?? "",
    })
    .select("*")
    .single()) as unknown as { data: ContactRow | null; error: { message: string } | null };
  return unwrap(result);
}

// ---------------------------------------------------------------------------
// vendor_contacts
// ---------------------------------------------------------------------------

export interface VendorContactWithDetail {
  /** vendor_contacts.id - the link row itself, for unlinking/editing the role. */
  vendorContactId: string;
  contactId: string;
  name: string;
  email: string;
  phone: string;
  role: VendorContactRole;
}

/**
 * Every contact linked to a vendor, joined with the contact's own fields -
 * exactly what send-to-vendor/send-to-broker/send-to-both (the UI
 * checklist item) needs to render its recipient picker, and what
 * sendRequest() itself re-derives server-side rather than trusting a
 * client-supplied recipient list at face value (see that function's own
 * docblock).
 */
export async function listVendorContacts(vendorId: string): Promise<VendorContactWithDetail[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("vendor_contacts")
    .select("id, role, contacts ( id, name, email, phone )")
    .eq("vendor_id", vendorId)) as unknown as {
    data: Array<{
      id: string;
      role: VendorContactRole;
      contacts: { id: string; name: string; email: string; phone: string } | null;
    }> | null;
    error: { message: string } | null;
  };
  const rows = unwrap({ data: result.data ?? [], error: result.error });

  return rows
    .filter(
      (
        row,
      ): row is (typeof rows)[number] & {
        contacts: NonNullable<(typeof rows)[number]["contacts"]>;
      } => row.contacts !== null,
    )
    .map((row) => ({
      vendorContactId: row.id,
      contactId: row.contacts.id,
      name: row.contacts.name,
      email: row.contacts.email,
      phone: row.contacts.phone,
      role: row.role,
    }));
}

/** Links an existing contact to a vendor under a role. Cross-tenant/cross-vendor integrity (contact and vendor must share company_id) is enforced by the migration's triggers, not re-checked here. */
export async function linkContactToVendor(input: {
  companyId: string;
  vendorId: string;
  contactId: string;
  role: VendorContactRole;
}): Promise<VendorContactRow> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("vendor_contacts")
    .insert({
      company_id: input.companyId,
      vendor_id: input.vendorId,
      contact_id: input.contactId,
      role: input.role,
    })
    .select("*")
    .single()) as unknown as { data: VendorContactRow | null; error: { message: string } | null };
  return unwrap(result);
}

export async function unlinkContactFromVendor(vendorContactId: string): Promise<void> {
  const supabase = await getRequestScopedClient();
  const { error } = await supabase.from("vendor_contacts").delete().eq("id", vendorContactId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// suppressed_recipients
// ---------------------------------------------------------------------------

/**
 * Whether an address is currently suppressed for a company. Normalizes the
 * same way the table's own trigger does (lower/trim) so a caller does not
 * need to duplicate that rule to get a match.
 */
export async function isEmailSuppressed(companyId: string, email: string): Promise<boolean> {
  const supabase = await getRequestScopedClient();
  const normalized = email.trim().toLowerCase();
  const { data, error } = await supabase
    .from("suppressed_recipients")
    .select("id")
    .eq("company_id", companyId)
    .eq("email", normalized)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}

/** Every active suppression for a company, most recent first - what a future operations view would list to let someone review/clear a suppression. */
export async function listSuppressedRecipients(
  companyId: string,
): Promise<SuppressedRecipientRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("suppressed_recipients")
    .select("*")
    .eq("company_id", companyId)
    .order("suppressed_at", { ascending: false })) as unknown as {
    data: SuppressedRecipientRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

// ---------------------------------------------------------------------------
// Communication history - email_outbox + email_delivery_events
// ---------------------------------------------------------------------------

export interface CommunicationHistoryEntry {
  outbox: EmailOutboxRow;
  events: EmailDeliveryEventRow[];
}

/**
 * Every outbound email for a vendor, each carrying its own full delivery
 * event history - the join a future CommunicationHistory.tsx needs to show
 * queued/sent/delivered/delayed/bounced/complained/failed per send.
 * email_delivery_events has a direct FK to email_outbox (migration 19), so
 * this is a genuine PostgREST embed, not the no-FK trap documented
 * elsewhere in this project's history (two independent references to a
 * shared parent do not make an embed; a direct FK does).
 */
export async function listCommunicationHistoryForVendor(
  vendorId: string,
): Promise<CommunicationHistoryEntry[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("email_outbox")
    .select("*, email_delivery_events ( * )")
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false })) as unknown as {
    data: Array<EmailOutboxRow & { email_delivery_events: EmailDeliveryEventRow[] }> | null;
    error: { message: string } | null;
  };
  const rows = unwrap({ data: result.data ?? [], error: result.error });

  return rows.map((row) => {
    const { email_delivery_events, ...outbox } = row;
    return {
      outbox: outbox as EmailOutboxRow,
      events: [...email_delivery_events].sort(
        (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
      ),
    };
  });
}
