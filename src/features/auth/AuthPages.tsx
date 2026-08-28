import { Link } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";

/**
 * DEMO-ONLY auth screens. No credentials are checked, stored or transmitted.
 */

function Field({
  id,
  label,
  type = "text",
  hint,
  autoComplete,
}: {
  id: string;
  label: string;
  type?: string;
  hint?: string;
  autoComplete?: string;
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
        <p className="text-sm font-bold tracking-tight text-foreground">VendorClear</p>
        <div className="mt-3 rounded-md border border-border bg-card p-6">
          <h1 className="text-lg font-bold tracking-tight text-foreground">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          <p className="mt-4 rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-semibold text-warn">
            Demo mode — this form does not authenticate anyone. Nothing is submitted or stored.
          </p>
          {children}
        </div>
        <div className="mt-4 text-sm text-muted-foreground">{footer}</div>
      </div>
    </div>
  );
}

function useDemoSubmit() {
  const [notice, setNotice] = useState<string | null>(null);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice("Demo mode: nothing was submitted, saved or emailed. Open the dashboard directly.");
  };
  return { notice, onSubmit };
}

function Notice({ notice }: { notice: string | null }) {
  if (!notice) return null;
  return (
    <p role="status" className="mt-3 rounded-sm border border-border bg-muted px-3 py-2 text-xs">
      {notice}
    </p>
  );
}

const submitClass =
  "focusable w-full rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground";

export function LoginPage() {
  const { notice, onSubmit } = useDemoSubmit();
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
        <Field id="email" label="Work email" type="email" autoComplete="email" />
        <Field id="password" label="Password" type="password" autoComplete="current-password" />
        <button type="submit" className={submitClass}>
          Sign in (demo)
        </button>
        <Notice notice={notice} />
      </form>
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        <Link to="/reset-password" className="focusable text-primary underline">
          Reset password
        </Link>
        <Link to="/dashboard" className="focusable text-primary underline">
          Open the demo dashboard
        </Link>
      </div>
    </AuthLayout>
  );
}

export function SignupPage() {
  const { notice, onSubmit } = useDemoSubmit();
  return (
    <AuthLayout
      title="Create an account"
      description="Set up compliance tracking for your subcontractor roster."
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
        <Field id="company" label="Company name" />
        <Field id="signup-email" label="Work email" type="email" autoComplete="email" />
        <Field
          id="signup-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="Minimum 12 characters in the production product."
        />
        <button type="submit" className={submitClass}>
          Create account (demo)
        </button>
        <Notice notice={notice} />
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { notice, onSubmit } = useDemoSubmit();
  return (
    <AuthLayout
      title="Reset password"
      description="We would normally send a one-time reset link."
      footer={
        <Link to="/login" className="focusable font-medium text-primary underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        <Field id="reset-email" label="Work email" type="email" autoComplete="email" />
        <button type="submit" className={submitClass}>
          Send reset link (demo)
        </button>
        <Notice notice={notice} />
      </form>
    </AuthLayout>
  );
}
