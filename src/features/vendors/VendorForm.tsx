import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { getRepository } from "@/data/repository";
import type { VendorTrade } from "@/data/contracts";

const trades: VendorTrade[] = [
  "Structural Steel",
  "Electrical",
  "Mechanical / HVAC",
  "Concrete",
  "Earthwork",
  "Roofing",
  "Glazing",
  "Fire Protection",
];

export function VendorForm({ onDone }: { onDone?: () => void }) {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: repo.createVendor,
    onSuccess: (vendor) => {
      void queryClient.invalidateQueries({ queryKey: ["vendors"] });
      setNotice(
        `${vendor.name} added to the in-memory demo roster. Nothing was uploaded, emailed or saved to a backend.`,
      );
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      name: String(form.get("vendor-name") ?? "").trim() || "Untitled vendor",
      trade: (form.get("vendor-trade") as VendorTrade) ?? "Concrete",
      project: String(form.get("vendor-project") ?? "").trim() || "Unassigned",
      contactName: String(form.get("vendor-contact") ?? "").trim(),
      contactEmail: String(form.get("vendor-email") ?? "").trim(),
      contractValue: Number(form.get("vendor-value") ?? 0),
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby="vendor-form-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2 id="vendor-form-heading" className="text-sm font-semibold text-foreground">
        Add vendor
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Demo-only: the vendor is held in memory for this session and starts with every requirement
        marked missing.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="vendor-name" className="block text-sm font-medium">
            Vendor name
          </label>
          <input
            id="vendor-name"
            name="vendor-name"
            required
            className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="vendor-trade" className="block text-sm font-medium">
            Trade
          </label>
          <select
            id="vendor-trade"
            name="vendor-trade"
            className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
          >
            {trades.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="vendor-project" className="block text-sm font-medium">
            Project
          </label>
          <input
            id="vendor-project"
            name="vendor-project"
            className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="vendor-value" className="block text-sm font-medium">
            Contract value (USD)
          </label>
          <input
            id="vendor-value"
            name="vendor-value"
            type="number"
            min={0}
            step={1000}
            className="numeric focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="vendor-contact" className="block text-sm font-medium">
            Primary contact
          </label>
          <input
            id="vendor-contact"
            name="vendor-contact"
            className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="vendor-email" className="block text-sm font-medium">
            Contact email
          </label>
          <input
            id="vendor-email"
            name="vendor-email"
            type="email"
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
          {mutation.isPending ? "Adding…" : "Add to demo roster"}
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
        <p role="status" className="mt-3 rounded-sm border border-border bg-muted px-3 py-2 text-xs">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
