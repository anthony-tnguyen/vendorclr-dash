import type { SuppressionReason, VendorContactRole } from "@/data/dbTypeAliases";

export const ROLE_LABEL: Record<VendorContactRole, string> = {
  operational: "Operational",
  broker: "Broker",
  secondary: "Secondary",
};

export const SUPPRESSION_LABEL: Record<SuppressionReason, string> = {
  bounced: "Hard bounce",
  complained: "Spam complaint",
  manual: "Do not email",
};

export const PURPOSE_LABEL: Record<string, string> = {
  renewal: "Renewal",
  initial: "Initial certificate",
  correction: "Correction",
};

export function suppressionSentence(reason: SuppressionReason): string {
  switch (reason) {
    case "bounced":
      return "This address hard-bounced. Requests are not emailed to it until the suppression is cleared.";
    case "complained":
      return "The recipient marked our email as spam. Requests are not emailed to it until the suppression is cleared.";
    case "manual":
      return "Marked do-not-email. Requests are not emailed to it until the suppression is cleared.";
  }
}

export const vendorContactsQueryKey = (vendorId: string) => ["vendor-contacts", vendorId] as const;
