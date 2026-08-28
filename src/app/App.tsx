import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { DemoRole } from "@/data/contracts";

/**
 * DEMO-ONLY session context. This is a presentation-layer role switcher for
 * previewing the two dashboards. It is NOT authentication and grants nothing.
 */
interface DemoSession {
  role: DemoRole;
  setRole: (role: DemoRole) => void;
  personName: string;
  companyName: string;
}

const DemoSessionContext = createContext<DemoSession | null>(null);

export function App({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<DemoRole>("customer");

  const value = useMemo<DemoSession>(
    () => ({
      role,
      setRole,
      personName: role === "admin" ? "VendorClear Operations" : "Rosa Sandoval",
      companyName: role === "admin" ? "VendorClear Internal" : "Halstead Builders",
    }),
    [role],
  );

  return <DemoSessionContext.Provider value={value}>{children}</DemoSessionContext.Provider>;
}

export function useDemoSession(): DemoSession {
  const ctx = useContext(DemoSessionContext);
  if (!ctx) {
    // Safe default so isolated component tests do not need the provider.
    return {
      role: "customer",
      setRole: () => {},
      personName: "Rosa Sandoval",
      companyName: "Halstead Builders",
    };
  }
  return ctx;
}
