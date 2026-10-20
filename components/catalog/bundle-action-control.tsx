"use client";

import Link from "next/link";

import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import type { BundleAction } from "@/lib/catalog/book-action";
import type { Dictionary } from "@/lib/i18n/dictionary";

// Renders the result of resolveBookAction for a bundle. It never grants access: buyAction
// re-checks the reader and create_bundle_order re-checks the bundle, the offer and what the reader
// already owns. Exported and standalone - mirrors components/catalog/book-action-control.tsx - so
// every action/signedIn combination is directly testable without going through the island's fetch.
export function BundleActionControl({
  action,
  signedIn,
  buyAction,
  signInPath,
  libraryPath,
  buyLabel,
  libraryLabel,
  copy,
}: {
  action: BundleAction;
  signedIn: boolean;
  buyAction: () => Promise<void>;
  signInPath: string;
  libraryPath: string;
  buyLabel: string;
  libraryLabel: string;
  copy: Dictionary["catalog"]["actions"];
}) {
  switch (action) {
    case "owned_bundle":
      return (
        <Button render={<Link href={libraryPath} />} size="lg" variant="outline">
          {libraryLabel}
        </Button>
      );
    case "buy":
      if (!signedIn) {
        return (
          <div className="space-y-2">
            <Button render={<Link href={signInPath} />} size="lg">
              {buyLabel}
            </Button>
            <p className="text-sm text-ink-soft">{copy.signInHint}</p>
          </div>
        );
      }
      return (
        <form action={buyAction}>
          <SubmitButton className="" pendingLabel={copy.pending} size="lg">
            {buyLabel}
          </SubmitButton>
        </form>
      );
    case "coming_soon":
      return (
        <Button disabled size="lg" variant="outline">
          {copy.comingSoon}
        </Button>
      );
    case "unavailable":
      return <p className="text-sm text-ink-soft">{copy.unavailable}</p>;
  }
}
