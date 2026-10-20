"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { fillTemplate } from "@/lib/i18n/format";

// The transfer reference itself is plain server-rendered text next to this control (spec 5.5), so a
// reader without JavaScript can still read and type it; this button only adds a one-tap copy.
//
// The button's accessible name always names what it copies, since a reader tabbing straight to it
// has none of the surrounding visual context. That name stays fixed rather than swapping to
// "Copied" on success, so a separate `role="status"` region announces the result instead - the next
// step here is pasting into a banking app, and a silent success is worse than a silent failure.
export function CopyReference({
  copiedLabel,
  copyAriaLabel,
  copyLabel,
  value,
}: {
  copiedLabel: string;
  copyAriaLabel: string;
  copyLabel: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied or unavailable (e.g. an insecure context); the reference
      // text next to this button is already selectable by hand.
    }
  }

  return (
    <>
      <Button
        aria-label={fillTemplate(copyAriaLabel, { reference: value })}
        className="min-h-11"
        onClick={handleCopy}
        size="sm"
        type="button"
        variant="outline"
      >
        {copied ? copiedLabel : copyLabel}
      </Button>
      <span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}
