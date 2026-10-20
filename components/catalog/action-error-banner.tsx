"use client";

import { useSearchParams } from "next/navigation";

// The banner a failed buy or claim redirects back to (see getCommerceRoutes().bookActionError()).
// It reads the query string in the browser so the page around it can be prerendered: reading
// searchParams on the server marks the whole route dynamic. The caller passes translated copy, so
// an unknown code renders nothing rather than an empty alert.
export function ActionErrorBanner({ messages }: { messages: Record<string, string> }) {
  const code = useSearchParams().get("action-error");
  const message = code ? messages[code] : undefined;
  if (!message) return null;

  return (
    <p className="mt-4 text-sm text-error" role="alert">
      {message}
    </p>
  );
}
