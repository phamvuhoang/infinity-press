"use client";

import { useActionState } from "react";

import type { GiftFormState } from "@/app/[lang]/(account)/checkout/[orderId]/gift-actions";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GIFT_MESSAGE_MAX_LENGTH, GIFT_RECIPIENT_EMAIL_MAX_LENGTH } from "@/lib/commerce/gift-form";
import type { OrderGift } from "@/lib/commerce/gifts";
import { fillTemplate } from "@/lib/i18n/format";

type Copy = {
  legend: string;
  description: string;
  emailLabel: string;
  messageLabel: string;
  save: string;
  saving: string;
  remove: string;
  removing: string;
  configured: string;
  lockedTransfer: string;
  invalidEmail: string;
  messageTooLong: string;
  unavailable: string;
};

type Action = (state: GiftFormState, formData: FormData) => Promise<GiftFormState>;

const initial: GiftFormState = { status: "idle" };

// Exported so the state-to-copy mapping can be checked without driving the form. The address leads
// when both fields are wrong: a gift with no valid recipient has nowhere to go, and a note that is
// merely too long is the smaller of the two problems to fix.
export function giftFormMessage(copy: Copy, state: GiftFormState): string | null {
  if (state.status === "unavailable") return copy.unavailable;
  if (state.status !== "invalid") return null;
  if (state.recipientEmail !== null) return copy.invalidEmail;
  if (state.message !== null) return copy.messageTooLong;
  return null;
}

// The checkout gift block (S9 spec 7.2). It sits ABOVE the coupon and the Pay button, because a
// fully discounted order completes the moment its coupon is applied - a gift arranged after that
// point would be arranged on an order that is already finished.
//
// What the purchaser can see here is exactly what get_my_order_gift returns: the address they
// typed, their own note, and the gift's status. The claim token and its hash are not fields of
// that read, so there is nothing to withhold - the component simply never has them.
export function GiftForm({
  copy,
  gift,
  // True once a bank transfer has been reported. configure_gift and remove_gift both refuse such
  // an order, so the form is not shown disabled, it is not shown: an input whose only outcome is
  // a refusal is worse than an explanation.
  locked,
  removeAction,
  saveAction,
}: {
  copy: Copy;
  gift: OrderGift | null;
  locked: boolean;
  removeAction: Action;
  saveAction: Action;
}) {
  const [saveState, save] = useActionState(saveAction, initial);
  const [removeState, remove] = useActionState(removeAction, initial);
  const message = giftFormMessage(copy, saveState) ?? giftFormMessage(copy, removeState);

  return (
    <section aria-labelledby="checkout-gift" className="mt-6 border-t border-hairline pt-6">
      <h2 className="font-medium" id="checkout-gift">
        {copy.legend}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">{copy.description}</p>

      {gift ? (
        <p className="mt-3 text-sm [overflow-wrap:anywhere]" role="status">
          {fillTemplate(copy.configured, { email: gift.recipientEmail })}
        </p>
      ) : null}

      {locked ? (
        <p className="mt-3 text-sm text-sage-text">{copy.lockedTransfer}</p>
      ) : (
        <>
          <form action={save} className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="gift-recipient-email">{copy.emailLabel}</Label>
              <Input
                autoComplete="off"
                className="min-h-11"
                defaultValue={gift?.recipientEmail ?? ""}
                id="gift-recipient-email"
                maxLength={GIFT_RECIPIENT_EMAIL_MAX_LENGTH}
                name="recipientEmail"
                spellCheck={false}
                type="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gift-message">{copy.messageLabel}</Label>
              <Textarea
                defaultValue={gift?.message ?? ""}
                id="gift-message"
                maxLength={GIFT_MESSAGE_MAX_LENGTH}
                name="message"
                rows={3}
              />
            </div>
            <SubmitButton className="min-h-11" pendingLabel={copy.saving} variant="secondary">
              {copy.save}
            </SubmitButton>
          </form>
          {gift ? (
            <form action={remove} className="mt-3">
              <SubmitButton className="min-h-11" pendingLabel={copy.removing} variant="ghost">
                {copy.remove}
              </SubmitButton>
            </form>
          ) : null}
        </>
      )}

      {message ? (
        <p className="mt-3 text-sm text-error" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}
