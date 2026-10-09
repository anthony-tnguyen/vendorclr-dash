import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { LegalConsent, LegalLinks } from "@/features/legal/LegalPages";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useSession } from "@/app/App";
import { getSupabaseClient } from "@/lib/supabase/client";
import { hasBackendEnv } from "@/lib/supabase/env";
import logoAsset from "@/assets/vendorclr-logo.svg.asset.json";

/**
 * Auth screens.
 *
 * With Supabase configured these perform real sign-in, sign-up and reset. Without
 * it they keep the original demo behavior and say plainly that they authenticate
 * nobody, so the preview and the test suite run with no backend.
 */

function Field({
  id,
  label,
  type = "text",
  hint,
  autoComplete,
  required,
}: {
  id: string;
  label: string;
  type?: string;
  hint?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        required={required}
        autoComplete={autoComplete ?? "off"}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="focusable w-full rounded-sm border border-input bg-card px-3 py-2 text-sm text-foreground"
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <img src={logoAsset.url} alt="VendorClr" className="h-8 w-auto" />
        <div className="mt-3 rounded-md border border-border bg-card p-6">
          <h1 className="text-lg font-bold tracking-tight text-foreground">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          {hasBackendEnv() ? null : (
            <p className="mt-4 rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-semibold text-warn">
              Demo mode — this form does not authenticate anyone. Nothing is submitted or stored.
            </p>
          )}
          {children}
        </div>
        <div className="mt-4 text-sm text-muted-foreground">{footer}</div>
        <LegalLinks className="mt-6 flex gap-3 text-xs text-muted-foreground" />
      </div>
    </div>
  );
}

interface AuthFormState {
  notice: string | null;
  error: string | null;
  pending: boolean;
  // When a submit reaches a terminal success - e.g. "check your email to
  // confirm" - there is nothing left to type. The page replaces the form with
  // the notice alone so the screen clearly reads as finished.
  done: boolean;
}

const IDLE: AuthFormState = { notice: null, error: null, pending: false, done: false };

/**
 * The shape a submit handler may return. A bare string is a notice that leaves
 * the form in place; `{ notice, done: true }` marks a terminal success so the
 * page can clear the form and show only the confirmation.
 */
type AuthFormResult = string | { notice: string; done?: boolean };

/**
 * Wraps a submit handler with pending/notice/error state. In demo mode the
 * handler is never called and the original demo notice is shown instead.
 */
function useAuthForm(handler: (form: FormData) => Promise<AuthFormResult>) {
  const [state, setState] = useState<AuthFormState>(IDLE);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    if (!hasBackendEnv()) {
      setState({
        notice: "Demo mode: nothing was submitted, saved or emailed. Open the dashboard directly.",
        error: null,
        pending: false,
        done: false,
      });
      return;
    }

    setState({ notice: null, error: null, pending: true, done: false });
    try {
      const result = await handler(form);
      const notice = typeof result === "string" ? result : result.notice;
      const done = typeof result === "string" ? false : (result.done ?? false);
      setState({ notice, error: null, pending: false, done });
    } catch (error) {
      setState({
        notice: null,
        error: error instanceof Error ? error.message : "Something went wrong. Try again.",
        pending: false,
        done: false,
      });
    }
  };

  return { ...state, onSubmit };
}

function Messages({ notice, error }: { notice: string | null; error: string | null }) {
  return (
    <>
      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="mt-3 rounded-sm border border-border bg-muted px-3 py-2 text-xs"
        >
          {notice}
        </p>
      ) : null}
    </>
  );
}

/**
 * Shown in place of a form once a submit reaches a terminal success (e.g. the
 * signup confirmation email is on its way). It is the only thing left on the
 * card, so the screen reads as finished rather than as a form still awaiting
 * input.
 */
function AuthConfirmation({ title, message }: { title: string; message: string }) {
  return (
    <div className="mt-4" role="status">
      <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="size-5">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <h2 className="mt-3 text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

const submitClass =
  "focusable w-full rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60";

function text(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

export function LoginPage() {
  const navigate = useNavigate();
  const live = hasBackendEnv();
  const { status, mode } = useSession();
  // Set by the console gate when a signed-out visitor is bounced here. Already
  // validated as a same-origin relative path by the route's validateSearch.
  const search = useSearch({ strict: false }) as { redirect?: string };
  const destination = (search.redirect ?? "/dashboard") as "/dashboard";

  // Someone already signed in has no business on the sign-in screen. Only in
  // live mode - demo sessions are permanently "authenticated" and the demo
  // sign-in screen is part of the tour.
  useEffect(() => {
    if (mode === "live" && status === "authenticated") {
      void navigate({ to: destination, replace: true });
    }
  }, [mode, status, destination, navigate]);

  const { notice, error, pending, onSubmit } = useAuthForm(async (form) => {
    const { error: signInError } = await getSupabaseClient().auth.signInWithPassword({
      email: text(form, "email"),
      password: String(form.get("password") ?? ""),
    });
    if (signInError) throw new Error(signInError.message);

    await navigate({ to: destination, replace: true });
    return "Signed in.";
  });

  return (
    <AuthLayout
      title="Sign in"
      description="Access the vendor compliance console."
      footer={
        <span>
          No account?{" "}
          <Link to="/signup" className="focusable font-medium text-primary underline">
            Create one
          </Link>
        </span>
      }
    >
      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        <Field id="email" label="Work email" type="email" autoComplete="email" required={live} />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required={live}
        />
        <button type="submit" disabled={pending} className={submitClass}>
          {pending ? "Signing in…" : live ? "Sign in" : "Sign in (demo)"}
        </button>
        <Messages notice={notice} error={error} />
      </form>
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        <Link to="/reset-password" className="focusable text-primary underline">
          Reset password
        </Link>
        {live ? null : (
          <Link to="/dashboard" className="focusable text-primary underline">
            Open the demo dashboard
          </Link>
        )}
      </div>
    </AuthLayout>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const live = hasBackendEnv();
  // Set when signup was reached from a flow like accept-invite that needs to
  // resume after account creation. Already validated as a same-origin
  // relative path by the route's validateSearch.
  const search = useSearch({ strict: false }) as { redirect?: string; plan?: string };
  const planParam =
    search.plan && ["core", "operations", "scale"].includes(search.plan) ? search.plan : null;
  // Where a brand-new account lands. An explicit redirect (e.g. accept-invite)
  // wins; otherwise a plan chosen on the marketing site sends them straight to
  // checkout, and the default is the demo screen.
  const destination = (search.redirect ?? "/demo") as "/demo";
  const destinationUrl = search.redirect ?? (planParam ? `/checkout?plan=${planParam}` : "/demo");

  async function goToDestination() {
    if (!search.redirect && planParam) {
      await navigate({ to: "/checkout", search: { plan: planParam } });
    } else {
      await navigate({ to: destination });
    }
  }

  const { notice, error, pending, done, onSubmit } = useAuthForm(async (form) => {
    // Sign-up is open: an account is created with no company attached, and the
    // handle_new_user() trigger creates the profile only. The workspace itself
    // arrives later, when an activation code is redeemed on the demo screen -
    // redeem_activation_code() is what creates the company and the owner seat,
    // in one transaction. So a fresh account lands on /demo by default -
    // unless `destination` says otherwise, e.g. accept-invite sending someone
    // back to finish accepting an invitation instead.
    const { data, error: signUpError } = await getSupabaseClient().auth.signUp({
      email: text(form, "signup-email"),
      password: String(form.get("signup-password") ?? ""),
      options: {
        data: {
          full_name: text(form, "full-name"),
        },
        // Without this, Supabase falls back to the project's Site URL setting
        // to build the confirmation link - which is a project-level default
        // most likely wrong for any deploy that isn't the one the project was
        // first configured against. Set explicitly here, same as
        // resetPasswordForEmail() below, so the link always lands back on
        // whichever origin the signup actually happened from, and on
        // `destination` rather than always /demo.
        emailRedirectTo: `${window.location.origin}${destinationUrl}`,
      },
    });
    if (signUpError) throw new Error(signUpError.message);

    if (data.session) {
      await goToDestination();
      return "Account created.";
    }
    // No session means Supabase is waiting on email confirmation: there is
    // nothing left to do on this screen, so mark it terminal and let the page
    // clear the form.
    return {
      notice: "Check your email to confirm the account, then sign in.",
      done: true,
    };
  });

  return (
    <AuthLayout
      title="Create an account"
      description="No code needed to look around. You'll land in the demo console, and your workspace opens when you enter an activation code."
      footer={
        <span>
          Already registered?{" "}
          <Link to="/login" className="focusable font-medium text-primary underline">
            Sign in
          </Link>
        </span>
      }
    >
      {done ? (
        <AuthConfirmation
          title="Check your email"
          message={notice ?? "Check your email to confirm the account, then sign in."}
        />
      ) : (
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <Field id="full-name" label="Your name" autoComplete="name" />
          <Field
            id="signup-email"
            label="Work email"
            type="email"
            autoComplete="email"
            required={live}
            hint="The address any activation code for your company will be issued to."
          />
          <Field
            id="signup-password"
            label="Password"
            type="password"
            autoComplete="new-password"
            required={live}
            hint="Minimum 12 characters."
          />
          <button type="submit" disabled={pending} className={submitClass}>
            {pending ? "Creating…" : live ? "Create account" : "Create account (demo)"}
          </button>
          <LegalConsent action="creating an account" />
          <Messages notice={notice} error={error} />
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const live = hasBackendEnv();

  const { notice, error, pending, onSubmit } = useAuthForm(async (form) => {
    const { error: resetError } = await getSupabaseClient().auth.resetPasswordForEmail(
      text(form, "reset-email"),
      { redirectTo: `${window.location.origin}/login` },
    );
    if (resetError) throw new Error(resetError.message);

    // Deliberately not confirming whether the address exists.
    return "If that address has an account, a reset link is on its way.";
  });

  return (
    <AuthLayout
      title="Reset password"
      description="We will send a one-time reset link."
      footer={
        <Link to="/login" className="focusable font-medium text-primary underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        <Field
          id="reset-email"
          label="Work email"
          type="email"
          autoComplete="email"
          required={live}
        />
        <button type="submit" disabled={pending} className={submitClass}>
          {pending ? "Sending…" : live ? "Send reset link" : "Send reset link (demo)"}
        </button>
        <Messages notice={notice} error={error} />
      </form>
    </AuthLayout>
  );
}
