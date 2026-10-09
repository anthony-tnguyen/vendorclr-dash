import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { isBackendConfigured } from "@/data/repository";
import { getSupabaseClient } from "@/lib/supabase/client";

/**
 * Account settings - the basics every signed-in user needs for their own
 * login, independent of any company.
 *
 * Deliberately NOT part of the Settings page: that page is company-scoped
 * (insurance requirements) and shows an error to anyone without a company, so
 * VendorClr staff - who belong to no company - could never reach a password
 * form there. This page only needs an authenticated session, which staff and
 * customers alike have.
 *
 * Two things live here:
 *   - Profile: the display name mirrored in public.profiles (RLS
 *     profiles_update_self lets a user write their own row) and the sign-in
 *     email, shown read-only.
 *   - Password: a self-service change. secure_password_change is off in
 *     supabase/config.toml, so Supabase itself does not demand the current
 *     password - we verify it here by re-authenticating before updating, so a
 *     left-open session cannot silently reset the password.
 *
 * Demo mode has no backend (getSupabaseClient throws), so the forms are
 * replaced with the same plain disclaimer the auth screens use.
 */

// Mirrors minimum_password_length in supabase/config.toml. The server rejects
// anything shorter regardless; checking here just gives a clearer message.
const MIN_PASSWORD_LENGTH = 12;

const sectionClass = "rounded-md border border-border bg-card p-4";
const labelClass = "block text-sm font-medium text-foreground";
const inputClass =
  "focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50";
const buttonClass =
  "focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50";

function Alert({ kind, children }: { kind: "error" | "status"; children: string }) {
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={
        kind === "error"
          ? "mt-3 rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
          : "mt-3 rounded-sm border border-border bg-muted px-3 py-2 text-xs"
      }
    >
      {children}
    </p>
  );
}

function ProfileSection() {
  const { userId, email, refresh } = useSession();

  const [fullName, setFullName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setLoaded(true);
      return;
    }
    void (async () => {
      const { data } = await getSupabaseClient()
        .from("profiles")
        .select("full_name")
        .eq("id", userId)
        .maybeSingle();
      if (cancelled) return;
      setFullName((data as { full_name?: string | null } | null)?.full_name ?? "");
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!userId) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    const trimmed = fullName.trim();
    const { error: updateError } = await getSupabaseClient()
      .from("profiles")
      .update({ full_name: trimmed === "" ? null : trimmed })
      .eq("id", userId);
    setSaving(false);
    if (updateError) {
      setError(updateError.message || "Could not save your name. Try again.");
      return;
    }
    setNotice("Your name has been updated.");
    // The displayed name in the shell comes from the session's identity read;
    // re-run it so the header reflects the change without a reload.
    refresh();
  };

  return (
    <section className={sectionClass} aria-labelledby="profile-h">
      <h2 id="profile-h" className="text-sm font-semibold">
        Profile
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Your name as it appears across the console.
      </p>
      <form onSubmit={onSubmit} className="mt-3 space-y-3">
        <div>
          <label htmlFor="account-name" className={labelClass}>
            Your name
          </label>
          <input
            id="account-name"
            name="account-name"
            type="text"
            autoComplete="name"
            value={fullName}
            disabled={!loaded || saving}
            onChange={(event) => {
              setNotice(null);
              setError(null);
              setFullName(event.target.value);
            }}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="account-email" className={labelClass}>
            Email
          </label>
          <input
            id="account-email"
            type="email"
            value={email ?? ""}
            readOnly
            aria-describedby="account-email-hint"
            className={`${inputClass} cursor-not-allowed`}
          />
          <p id="account-email-hint" className="mt-1 text-xs text-muted-foreground">
            This is your sign-in address. Contact VendorClr to change it.
          </p>
        </div>
        <button type="submit" disabled={!loaded || saving} className={buttonClass}>
          {saving ? "Saving…" : "Save name"}
        </button>
        {error ? <Alert kind="error">{error}</Alert> : null}
        {notice ? <Alert kind="status">{notice}</Alert> : null}
      </form>
    </section>
  );
}

function PasswordSection() {
  const { email } = useSession();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setCurrent("");
    setNext("");
    setConfirm("");
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    setError(null);

    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    if (current === next) {
      setError("Your new password must be different from your current one.");
      return;
    }
    if (!email) {
      setError("We could not read your account email. Sign in again and retry.");
      return;
    }

    setSaving(true);
    const supabase = getSupabaseClient();

    // Verify the current password by re-authenticating. Supabase does not
    // require it (secure_password_change is off), so this is the only thing
    // stopping a left-open session from being used to change the password.
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: current,
    });
    if (signInError) {
      setSaving(false);
      setError("Your current password is incorrect.");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: next });
    setSaving(false);
    if (updateError) {
      setError(updateError.message || "Could not update your password. Try again.");
      return;
    }
    reset();
    setNotice("Your password has been changed.");
  };

  return (
    <section className={sectionClass} aria-labelledby="password-h">
      <h2 id="password-h" className="text-sm font-semibold">
        Password
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Choose a new password. You will stay signed in on this device.
      </p>
      <form onSubmit={onSubmit} className="mt-3 space-y-3">
        <div>
          <label htmlFor="current-password" className={labelClass}>
            Current password
          </label>
          <input
            id="current-password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="new-password" className={labelClass}>
            New password
          </label>
          <input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            aria-describedby="new-password-hint"
            onChange={(event) => setNext(event.target.value)}
            className={inputClass}
          />
          <p id="new-password-hint" className="mt-1 text-xs text-muted-foreground">
            Minimum {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        <div>
          <label htmlFor="confirm-password" className={labelClass}>
            Confirm new password
          </label>
          <input
            id="confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className={inputClass}
          />
        </div>
        <button type="submit" disabled={saving} className={buttonClass}>
          {saving ? "Updating…" : "Change password"}
        </button>
        {error ? <Alert kind="error">{error}</Alert> : null}
        {notice ? <Alert kind="status">{notice}</Alert> : null}
      </form>
    </section>
  );
}

/** The panels, split out so tests can mount them without the console shell. */
export function AccountSettings() {
  if (!isBackendConfigured()) {
    return (
      <p
        role="note"
        className="rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-semibold text-warn"
      >
        Demo mode — there is no account to manage here. Sign-in, profile and password changes are
        only available once a real backend is configured.
      </p>
    );
  }
  return (
    <div className="grid max-w-xl gap-4">
      <ProfileSection />
      <PasswordSection />
    </div>
  );
}

export function AccountPage() {
  return (
    <AppShell title="Account" subtitle="Your profile and sign-in details.">
      <AccountSettings />
    </AppShell>
  );
}
