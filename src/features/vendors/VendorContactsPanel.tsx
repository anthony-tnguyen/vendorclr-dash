import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import type { VendorContactRole } from "@/data/dbTypeAliases";
import {
  addVendorContact,
  changeContactRole,
  CONTACT_ROLES,
  editContact,
  getVendorContactsPanel,
  linkExistingContact,
  setRecipientSuppression,
  unlinkVendorContact,
  type VendorContactView,
} from "@/workflows/vendorContacts";

import {
  ROLE_LABEL,
  SUPPRESSION_LABEL,
  suppressionSentence,
  vendorContactsQueryKey,
} from "./contactLabels";

/**
 * Contacts section of vendor detail: who requests go to for this vendor,
 * in what role, and whether their address can currently receive mail.
 *
 * Suppression is shown on every row it applies to, in words, not just a
 * colour - a bounced or complained address is the one thing a person
 * sending a request most needs to notice. Write controls render only for
 * roles that can write; the server functions and RLS enforce it regardless.
 */

const input = "focusable w-full rounded-sm border border-input bg-background px-2 py-1.5 text-xs";
const smallButton =
  "focusable rounded-sm border border-border px-2 py-1 text-[11px] font-medium disabled:opacity-60";

interface ContactFormValues {
  name: string;
  organization: string;
  email: string;
  phone: string;
  role: VendorContactRole;
}

const EMPTY_FORM: ContactFormValues = {
  name: "",
  organization: "",
  email: "",
  phone: "",
  role: "broker",
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function SuppressionBadge({ reason }: { reason: VendorContactView["suppression"] }) {
  if (!reason) return null;
  return (
    <span
      className="inline-flex items-center rounded-sm border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive"
      title={suppressionSentence(reason.reason)}
    >
      {SUPPRESSION_LABEL[reason.reason]}
    </span>
  );
}

function ContactFields({
  values,
  onChange,
  showRole,
  idPrefix,
}: {
  values: ContactFormValues;
  onChange: (next: ContactFormValues) => void;
  showRole: boolean;
  idPrefix: string;
}) {
  const field = (key: keyof ContactFormValues, label: string, type = "text", required = false) => (
    <label
      className="block text-[11px] font-medium text-muted-foreground"
      htmlFor={`${idPrefix}-${key}`}
    >
      {label}
      <input
        id={`${idPrefix}-${key}`}
        type={type}
        required={required}
        value={values[key]}
        onChange={(e) => onChange({ ...values, [key]: e.target.value })}
        className={`${input} mt-1 text-foreground`}
      />
    </label>
  );
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {field("name", "Name", "text", true)}
      {field("organization", "Agency / company")}
      {field("email", "Email", "email", true)}
      {field("phone", "Phone", "tel")}
      {showRole ? (
        <label
          className="block text-[11px] font-medium text-muted-foreground"
          htmlFor={`${idPrefix}-role`}
        >
          Role
          <select
            id={`${idPrefix}-role`}
            value={values.role}
            onChange={(e) => onChange({ ...values, role: e.target.value as VendorContactRole })}
            className={`${input} mt-1 text-foreground`}
          >
            {CONTACT_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function ContactRow({
  vendorId,
  contact,
  canWrite,
}: {
  vendorId: string;
  contact: VendorContactView;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<ContactFormValues>({
    name: contact.name,
    organization: contact.organization,
    email: contact.email,
    phone: contact.phone,
    role: contact.role,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: vendorContactsQueryKey(vendorId) }),
      queryClient.invalidateQueries({ queryKey: ["vendor-contacts"] }),
    ]);

  const save = useMutation({
    mutationFn: () =>
      editContact({
        data: {
          contactId: contact.contactId,
          name: values.name,
          organization: values.organization,
          email: values.email,
          phone: values.phone,
        },
      }),
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
  });
  const role = useMutation({
    mutationFn: (next: VendorContactRole) =>
      changeContactRole({ data: { vendorContactId: contact.vendorContactId, role: next } }),
    onSuccess: refresh,
  });
  const unlink = useMutation({
    mutationFn: () => unlinkVendorContact({ data: { vendorContactId: contact.vendorContactId } }),
    onSuccess: refresh,
  });
  const suppression = useMutation({
    mutationFn: (suppressed: boolean) =>
      setRecipientSuppression({ data: { vendorId, email: contact.email, suppressed } }),
    onSuccess: refresh,
  });

  const failure = save.error ?? role.error ?? unlink.error ?? suppression.error;

  return (
    <li
      className="border-t border-border py-3 first:border-t-0"
      data-testid="vendor-contact"
      aria-label={`${contact.name}, ${ROLE_LABEL[contact.role]}`}
    >
      {editing ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
          className="space-y-2"
        >
          <ContactFields
            values={values}
            onChange={setValues}
            showRole={false}
            idPrefix={`edit-${contact.vendorContactId}`}
          />
          {contact.linkedVendorCount > 1 ? (
            <p className="text-[11px] text-muted-foreground">
              Shared with {contact.linkedVendorCount} vendors — changes apply to all of them.
            </p>
          ) : null}
          <div className="flex gap-2">
            <button type="submit" disabled={save.isPending} className={smallButton}>
              {save.isPending ? "Saving…" : "Save contact"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={smallButton}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 text-sm">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {contact.name}
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {ROLE_LABEL[contact.role]}
              </span>
              <SuppressionBadge reason={contact.suppression} />
            </p>
            {contact.organization ? (
              <p className="text-xs text-muted-foreground">{contact.organization}</p>
            ) : null}
            <p className="break-all text-xs">{contact.email}</p>
            {contact.phone ? (
              <p className="text-xs text-muted-foreground">{contact.phone}</p>
            ) : null}
            {contact.suppression ? (
              <p className="mt-1 text-[11px] text-destructive">
                {suppressionSentence(contact.suppression.reason)}
              </p>
            ) : null}
            {contact.linkedVendorCount > 1 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Also a contact for {contact.linkedVendorCount - 1} other vendor
                {contact.linkedVendorCount - 1 === 1 ? "" : "s"}.
              </p>
            ) : null}
          </div>
          {canWrite ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <label className="sr-only" htmlFor={`role-${contact.vendorContactId}`}>
                Role for {contact.name}
              </label>
              <select
                id={`role-${contact.vendorContactId}`}
                value={contact.role}
                disabled={role.isPending}
                onChange={(e) => role.mutate(e.target.value as VendorContactRole)}
                className="focusable rounded-sm border border-border bg-background px-1.5 py-1 text-[11px]"
              >
                {CONTACT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setEditing(true)} className={smallButton}>
                Edit
              </button>
              <button
                type="button"
                disabled={suppression.isPending}
                onClick={() => {
                  if (
                    contact.suppression &&
                    !window.confirm(
                      `Clear the suppression for ${contact.email}? Requests will be emailed to it again.`,
                    )
                  ) {
                    return;
                  }
                  suppression.mutate(!contact.suppression);
                }}
                className={smallButton}
              >
                {contact.suppression ? "Clear suppression" : "Mark do-not-email"}
              </button>
              <button
                type="button"
                disabled={unlink.isPending}
                onClick={() => unlink.mutate()}
                className={smallButton}
                aria-label={`Unlink ${contact.name} (${ROLE_LABEL[contact.role]})`}
              >
                Unlink
              </button>
            </div>
          ) : null}
        </div>
      )}
      {failure ? (
        <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
          {errorText(failure, "That change could not be saved.")}
        </p>
      ) : null}
    </li>
  );
}

export function VendorContactsPanel({
  vendorId,
  canWrite,
}: {
  vendorId: string;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"idle" | "add" | "link">("idle");
  const [form, setForm] = useState<ContactFormValues>(EMPTY_FORM);
  const [linkContactId, setLinkContactId] = useState("");
  const [linkRole, setLinkRole] = useState<VendorContactRole>("broker");
  const [notice, setNotice] = useState<string | null>(null);

  const panel = useQuery({
    queryKey: vendorContactsQueryKey(vendorId),
    queryFn: () => getVendorContactsPanel({ data: { vendorId } }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["vendor-contacts"] });

  const add = useMutation({
    mutationFn: () => addVendorContact({ data: { vendorId, ...form } }),
    onSuccess: async (result) => {
      setNotice(
        result.reusedExisting
          ? `${form.email} was already in your contacts — linked the existing contact instead of creating a duplicate.`
          : `Added ${form.name}.`,
      );
      setForm(EMPTY_FORM);
      setMode("idle");
      await refresh();
    },
  });
  const link = useMutation({
    mutationFn: () =>
      linkExistingContact({ data: { vendorId, contactId: linkContactId, role: linkRole } }),
    onSuccess: async () => {
      setNotice("Contact linked.");
      setLinkContactId("");
      setMode("idle");
      await refresh();
    },
  });

  const contacts = panel.data?.contacts ?? [];

  return (
    <section
      aria-labelledby="contacts-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="contacts-heading" className="text-sm font-semibold text-foreground">
          Contacts
        </h2>
        {canWrite ? (
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setMode(mode === "add" ? "idle" : "add");
              }}
              className={smallButton}
            >
              Add contact
            </button>
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setMode(mode === "link" ? "idle" : "link");
              }}
              className={smallButton}
            >
              Link existing contact
            </button>
          </div>
        ) : null}
      </div>

      {notice ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {mode === "add" ? (
        <form
          aria-label="Add contact"
          className="mt-3 space-y-2 rounded-sm border border-border bg-muted p-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <ContactFields values={form} onChange={setForm} showRole idPrefix="add-contact" />
          <p className="text-[11px] text-muted-foreground">
            If this email is already in your contacts (for example a broker who covers other
            vendors), the existing contact is linked rather than duplicated.
          </p>
          <button type="submit" disabled={add.isPending} className={smallButton}>
            {add.isPending ? "Adding…" : "Save contact"}
          </button>
          {add.isError ? (
            <p role="alert" className="text-xs font-semibold text-destructive">
              {errorText(add.error, "Could not add the contact.")}
            </p>
          ) : null}
        </form>
      ) : null}

      {mode === "link" ? (
        <form
          aria-label="Link existing contact"
          className="mt-3 grid gap-2 rounded-sm border border-border bg-muted p-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (linkContactId) link.mutate();
          }}
        >
          <label
            className="block text-[11px] font-medium text-muted-foreground"
            htmlFor="link-contact"
          >
            Contact
            <select
              id="link-contact"
              required
              value={linkContactId}
              onChange={(e) => setLinkContactId(e.target.value)}
              className={`${input} mt-1 text-foreground`}
            >
              <option value="">Choose a contact…</option>
              {(panel.data?.addressBook ?? []).map((c) => (
                <option key={c.contactId} value={c.contactId}>
                  {c.name}
                  {c.organization ? ` — ${c.organization}` : ""} ({c.email})
                  {c.suppression ? ` · ${SUPPRESSION_LABEL[c.suppression.reason]}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label
            className="block text-[11px] font-medium text-muted-foreground"
            htmlFor="link-role"
          >
            Role
            <select
              id="link-role"
              value={linkRole}
              onChange={(e) => setLinkRole(e.target.value as VendorContactRole)}
              className={`${input} mt-1 text-foreground`}
            >
              {CONTACT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={link.isPending || !linkContactId} className={smallButton}>
            {link.isPending ? "Linking…" : "Link contact"}
          </button>
          {link.isError ? (
            <p role="alert" className="text-xs font-semibold text-destructive sm:col-span-3">
              {errorText(link.error, "Could not link the contact.")}
            </p>
          ) : null}
        </form>
      ) : null}

      {panel.isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading contacts…</p>
      ) : panel.isError ? (
        <p role="alert" className="mt-3 text-xs font-semibold text-destructive">
          {errorText(panel.error, "Contacts could not be loaded.")}
        </p>
      ) : contacts.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No contacts yet. Add the vendor's operational contact or their insurance broker to send
          document requests.
        </p>
      ) : (
        <ul className="mt-2">
          {contacts.map((contact) => (
            <ContactRow
              key={contact.vendorContactId}
              vendorId={vendorId}
              contact={contact}
              canWrite={canWrite}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
