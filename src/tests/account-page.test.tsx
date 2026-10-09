import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountSettings } from "@/features/account/AccountPage";

/**
 * AccountSettings is the company-independent account panel: a profile-name
 * save and a password change that re-authenticates before updating.
 */

const refresh = vi.fn();
const session = {
  userId: "user-1",
  email: "person@acme.test",
  personName: "Person One",
  refresh,
};

vi.mock("@/app/App", () => ({ useSession: () => session }));

let backendConfigured = true;
vi.mock("@/data/repository", () => ({ isBackendConfigured: () => backendConfigured }));

type Result = { error: { message: string } | null };
const signInWithPassword = vi.fn(async (): Promise<Result> => ({ error: null }));
const updateUser = vi.fn(async (): Promise<Result> => ({ error: null }));
const profileUpdateEq = vi.fn(async (): Promise<Result> => ({ error: null }));
const profileMaybeSingle = vi.fn(async () => ({ data: { full_name: "Person One" }, error: null }));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: () => ({
    auth: {
      signInWithPassword: (...args: unknown[]) => signInWithPassword(...(args as [])),
      updateUser: (...args: unknown[]) => updateUser(...(args as [])),
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => profileMaybeSingle() }) }),
      update: () => ({ eq: (...args: unknown[]) => profileUpdateEq(...(args as [])) }),
    }),
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
  backendConfigured = true;
});

describe("AccountSettings", () => {
  it("changes the password after verifying the current one", async () => {
    render(<AccountSettings />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Current password"), "oldpassword123");
    await user.type(screen.getByLabelText("New password"), "brandnewpassword1");
    await user.type(screen.getByLabelText("Confirm new password"), "brandnewpassword1");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => {
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: "person@acme.test",
        password: "oldpassword123",
      });
      expect(updateUser).toHaveBeenCalledWith({ password: "brandnewpassword1" });
    });
    expect(await screen.findByText("Your password has been changed.")).toBeInTheDocument();
  });

  it("rejects a new password shorter than the minimum without calling Supabase", async () => {
    render(<AccountSettings />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Current password"), "oldpassword123");
    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "short");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText(/at least 12 characters/)).toBeInTheDocument();
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("surfaces a wrong current password and does not update", async () => {
    signInWithPassword.mockResolvedValueOnce({ error: { message: "Invalid login credentials" } });
    render(<AccountSettings />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Current password"), "wrongpassword1");
    await user.type(screen.getByLabelText("New password"), "brandnewpassword1");
    await user.type(screen.getByLabelText("Confirm new password"), "brandnewpassword1");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Your current password is incorrect.")).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("saves the profile name and refreshes the session", async () => {
    render(<AccountSettings />);
    const user = userEvent.setup();

    const nameField = await screen.findByLabelText("Your name");
    await waitFor(() => expect(nameField).not.toBeDisabled());
    await user.clear(nameField);
    await user.type(nameField, "New Name");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => {
      expect(profileUpdateEq).toHaveBeenCalled();
      expect(refresh).toHaveBeenCalled();
    });
    expect(await screen.findByText("Your name has been updated.")).toBeInTheDocument();
  });

  it("shows a demo-mode notice when no backend is configured", () => {
    backendConfigured = false;
    render(<AccountSettings />);
    expect(screen.getByText(/Demo mode/)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });
});
