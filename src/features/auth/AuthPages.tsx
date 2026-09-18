import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useSession } from "@/app/App";
import { getSupabaseClient } from "@/lib/supabase/client";
import { hasBackendEnv } from "@/lib/supabase/env";

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
        <img src="/vendorclr-logo-black.svg" alt="VendorClr" className="h-5 w-auto" />
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
      </div>
    </div>
  );
}

interface AuthFormState {
  notice: string | null;
  error: string | null;
  pending: boolean;
}

const IDLE: AuthFormState = { notice: null, error: null, pending: false };

/**
 * Wraps a submit handler with pending/notice/error state. In demo mode the
 * handler is never called and the original demo notice is shown instead.
 */
function useAuthForm(handler: (form: FormData) => Promise<string>) {
  const [state, setState] = useState<AuthFormState>(IDLE);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    if (!hasBackendEnv()) {
      setState({
        notice: "Demo mode: nothing was submitted, saved or emailed. Open the dashboard directly.",
        error: null,
        pending: false,
      });
      return;
    }

    setState({ notice: null, error: null, pending: true });
    try {
      const notice = await handler(form);
      setState({ notice, error: null, pending: false });
    } catch (error) {
      setState({
        notice: null,
        error: error instanceof Error ? error.message : "Something went wrong. Try again.",
        pending: false,
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

  const { notice, error, pending, onSubmit } = useAuthForm(async (form) => {
    // Sign-up is open: an account is created with no company attached, and the
    // handle_new_user() trigger creates the profile only. The workspace itself
    // arrives later, when an activation code is redeemed on the demo screen -
    // redeem_activation_code() is what creates the company and the owner seat,
    // in one transaction. So a fresh account lands on /demo, not /dashboard.
    const { data, error: signUpError } = await getSupabaseClient().auth.signUp({
      email: text(form, "signup-email"),
      password: String(form.get("signup-password") ?? ""),
      options: {
        data: {
          full_name: text(form, "full-name"),
        },
      },
    });
    if (signUpError) throw new Error(signUpError.message);

    if (data.session) {
      await navigate({ to: "/demo" });
      return "Account created.";
    }
    return "Check your email to confirm the account, then sign in.";
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
        <Messages notice={notice} error={error} />
      </form>
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
