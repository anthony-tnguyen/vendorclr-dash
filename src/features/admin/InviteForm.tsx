import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { getRepository } from "@/data/repository";

export function InviteForm({ onDone }: { onDone?: () => void }) {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: repo.createSignupInvite,
    onSuccess: (invite) => {
      void queryClient.invalidateQueries({ queryKey: ["signup-invites"] });
      setNotice(`Invite code ${invite.code} created for ${invite.companyName} (${invite.email}).`);
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      companyName: String(form.get("invite-company") ?? "").trim(),
      email: String(form.get("invite-email") ?? "").trim(),
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby="invite-form-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2 id="invite-form-heading" className="text-sm font-semibold text-foreground">
        Create invite
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The code is locked to this email and this company name, and expires in 14 days.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="invite-company" className="block text-sm font-medium">
            Company name
          </label>
          <input
            id="invite-company"
            name="invite-company"
            required
            className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="invite-email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="invite-email"
            name="invite-email"
            type="email"
            required
            className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {mutation.isPending ? "Creating…" : "Create invite"}
        </button>
        {onDone ? (
          <button
            type="button"
            onClick={onDone}
            className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
          >
            Cancel
          </button>
        ) : null}
      </div>

      {notice ? (
        <p
          role="status"
          className="mt-3 rounded-sm border border-border bg-muted px-3 py-2 text-xs"
        >
          {notice}
        </p>
      ) : null}
      {mutation.isError ? (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
        >
          {mutation.error instanceof Error
            ? mutation.error.message
            : "Could not create the invite."}
        </p>
      ) : null}
    </form>
  );
}
