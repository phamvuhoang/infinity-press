"use client";

import { useActionState } from "react";
import { defaultLocale, localeRegistry, locales } from "@/lib/i18n/config";

import { initialGiftActionState, reissueGiftAction, resendGiftAction, type GiftActionState } from "@/app/admin/gifts/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { Locale } from "@/lib/i18n/config";

// The two support mutations for one gift row. Both are Server Actions that call requireAdmin
// themselves; rendering or withholding a form here is presentation, never authorization.
//
// Nothing in this component ever holds a claim link: reissueGiftAction returns a sentence, not a
// URL, because a token that reached this component would be in browser state and in history.

function Feedback({ state, id }: { state: GiftActionState; id: string }) {
  if (state.status === "error") {
    return (
      <p className="text-[0.8125rem] text-error" id={id} role="alert">
        {state.message}
      </p>
    );
  }
  if (state.status === "done") {
    return (
      <p className="text-[0.8125rem] text-success" role="status">
        {state.message}
      </p>
    );
  }
  return null;
}

function ResendForm({ giftId }: { giftId: string }) {
  const [state, formAction, pending] = useActionState(resendGiftAction.bind(null, giftId), initialGiftActionState);

  return (
    <form action={formAction} aria-busy={pending} className="space-y-2">
      <Button className="min-h-11" disabled={pending} type="submit" variant="outline">
        {pending ? "Resending…" : "Resend to the same address"}
      </Button>
      <Feedback id={`resend-${giftId}-message`} state={state} />
    </form>
  );
}

function ReissueForm({ giftId, claimLocale }: { giftId: string; claimLocale: Locale | null }) {
  const [state, formAction, pending] = useActionState(reissueGiftAction.bind(null, giftId), initialGiftActionState);

  return (
    <form action={formAction} aria-busy={pending} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`reissue-email-${giftId}`}>New recipient email</Label>
        <Input
          aria-describedby={state.status === "error" ? `reissue-${giftId}-message` : undefined}
          className="min-h-11"
          id={`reissue-email-${giftId}`}
          name="recipientEmail"
          required
          type="email"
        />
      </div>
      <div className="space-y-2">
        {/* The language the recipient's message is written in, defaulted to the one the gift was
            first sent in so a corrected address does not silently switch languages. */}
        <Label htmlFor={`reissue-locale-${giftId}`}>Email language</Label>
        <NativeSelect defaultValue={claimLocale ?? defaultLocale} id={`reissue-locale-${giftId}`} name="locale">
          {locales.map((code) => (
            <option key={code} value={code}>
              {localeRegistry[code].nativeName}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`reissue-reason-${giftId}`}>Reason</Label>
        <Textarea className="min-h-20" id={`reissue-reason-${giftId}`} name="reason" required />
      </div>
      <Button className="min-h-11" disabled={pending} type="submit" variant="destructive">
        {pending ? "Reissuing…" : "Reissue to a new address"}
      </Button>
      <Feedback id={`reissue-${giftId}-message`} state={state} />
    </form>
  );
}

export function GiftActions({
  giftId,
  orderId,
  status,
  claimLocale,
}: {
  giftId: string;
  orderId: string;
  status: "pending" | "sent" | "claimed" | "revoked";
  claimLocale: Locale | null;
}) {
  // A claimed gift is a real entitlement, withdrawn on the order (spec 7.4). Note for the
  // operator's benefit: a book revoked after a claim simply drops out of the recipient's claim
  // page if they reopen it, so tell them what happened rather than leaving them to notice.
  if (status === "claimed") {
    return (
      <p className="text-[0.8125rem] text-sage-text">
        Claimed, so the books belong to the recipient.{" "}
        <a
          className="underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
          href={`/admin/orders/${orderId}`}
        >
          Revoke access on the order
        </a>{" "}
        to take them back, and tell the recipient - a revoked book just disappears from their claim
        page without explanation.
      </p>
    );
  }

  // A pending gift's order has not been paid for. There is no link out yet, so there is nothing to
  // resend and nothing to retire; the purchaser can still correct the address at checkout. Neither
  // RPC will touch it - `sent` is what an order completing sets, and claim_gift trusts that status
  // rather than rechecking payment, so activating one here would grant access nobody bought.
  if (status === "pending") {
    return <p className="text-[0.8125rem] text-sage-text">Waiting for payment. No claim link has been sent yet.</p>;
  }

  if (status === "revoked") {
    return (
      <p className="text-[0.8125rem] text-sage-text">
        Revoked, so the claim link is dead and there is none to replace. Refund the order or sell a new gift.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ResendForm giftId={giftId} />
      <ReissueForm claimLocale={claimLocale} giftId={giftId} />
    </div>
  );
}
