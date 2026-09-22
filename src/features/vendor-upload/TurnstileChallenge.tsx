import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "error-callback": () => void;
          "expired-callback": () => void;
        },
      ) => string;
      remove: (id: string) => void;
    };
  }
}

export function TurnstileChallenge({
  siteKey,
  onToken,
}: {
  siteKey: string | undefined;
  onToken: (token: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!siteKey) {
      setMessage(
        "Security verification is unavailable. Please retry later or contact the requester.",
      );
      return;
    }
    const render = () => {
      if (host.current && window["turnstile"])
        window["turnstile"].render(host.current, {
          sitekey: siteKey,
          callback: onToken,
          "error-callback": () => setMessage("Security verification failed. Please try again."),
          "expired-callback": () =>
            setMessage("Security verification expired. Please complete it again."),
        });
    };
    const existing = document.querySelector<HTMLScriptElement>("script[data-turnstile]");
    if (existing) {
      existing.addEventListener("load", render);
      render();
      return () => existing.removeEventListener("load", render);
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.dataset["turnstile"] = "true";
    script.addEventListener("load", render);
    document.head.append(script);
    return () => script.removeEventListener("load", render);
  }, [onToken, siteKey]);
  return (
    <section aria-label="Security verification" className="mt-3 rounded border border-border p-3">
      <p className="text-sm font-medium">Security verification</p>
      <div ref={host} className="mt-2" />
      {message ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </section>
  );
}
