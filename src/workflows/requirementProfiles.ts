export function validateRequirementProfileInput(name: string): string {
  const value = name.trim();
  if (!value) throw new Error("Profile name is required");
  return value;
}

export function validateAssignmentInput(input: {
  vendorId: string;
  contractValue: string;
}): number | null {
  if (!input.vendorId) throw new Error("Select a vendor before assigning it to this project.");
  if (input.contractValue.trim() === "") return null;
  const value = Number(input.contractValue);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error("Contract value must be a non-negative whole dollar amount.");
  }
  return value;
}
