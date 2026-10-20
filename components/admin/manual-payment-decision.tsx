"use client";

import { useActionState, useState } from "react";

import {
  confirmManualPaymentAction,
  declineManualPaymentAction,
  type ManualDecisionState,
} from "@/app/admin/orders/[orderId]/manual-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatPrice } from "@/lib/catalog/price";

const initialState: ManualDecisionState = { status: "idle" };

// The two decisions an admin can make on a reported bank transfer (spec 5.6). Two independent
// useActionState calls, not one shared state: confirming and declining are different forms with
// different fields, and mixing their pending/error states would make one form flicker on the
// other's submit.
export function ManualPaymentDecision({
  orderId,
  expectedAmountMinor,
  currency,
}: {
  orderId: string;
  expectedAmountMinor: number;
  currency: string;
}) {
  const [confirmState, confirmFormAction, confirmPending] = useActionState(
    confirmManualPaymentAction.bind(null, orderId),
    initialState,
  );
  const [declineState, declineFormAction, declinePending] = useActionState(
    declineManualPaymentAction.bind(null, orderId),
    initialState,
  );

  // React resets every uncontrolled field of a <form action={...}> whenever the action resolves
  // without throwing - not only on success, but on a mismatch or a friendly error too, since none of
  // those are a thrown exception. Left uncontrolled, the bank reference an admin just typed would
  // vanish the moment a mismatch came back, silently blocking the very retry this screen exists for
  // (the "required" field then fails the browser's own validation and the resubmit goes nowhere).
  // Keeping these fields controlled is what makes a retry after a mismatch or a transient error
  // actually work, in the browser and not only in this component's own state.
  const [amount, setAmount] = useState(() => String(expectedAmountMinor));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  const [mismatchAccepted, setMismatchAccepted] = useState(false);

  // Every result the action produces - a fresh mismatch, a different error, or success - clears the
  // tick, adjusted during render rather than in an effect (React's own pattern for resetting state
  // when a value changes). Money that did not arrive must never be granted access by a checkbox left
  // ticked from a previous submission; the admin re-reads the two numbers and says so again each
  // time.
  const [lastConfirmState, setLastConfirmState] = useState(confirmState);
  if (lastConfirmState !== confirmState) {
    setLastConfirmState(confirmState);
    setMismatchAccepted(false);
  }

  // A mismatch banner describes one specific received amount. The moment the field no longer holds
  // that amount, the banner is describing a submission the admin is not about to make - so it (and
  // the override that goes with it) must disappear rather than sit there ticked, or re-tickable,
  // against a number that has moved on. This is checked on every render, not reset once on an edit:
  // an admin can retick a visible checkbox as an ordinary reflex, so the fix has to be that there is
  // nothing to retick, not that a tick gets cleared and could be re-set.
  //
  // The comparison uses the same strict parsing confirmManualPaymentAction applies server-side (a
  // bare non-negative integer, nothing else), so a field the server would itself reject - blank,
  // padded with whitespace, or non-numeric - never accidentally matches the banner by loose
  // coercion. Submitting a genuinely different amount simply asks the server again and gets a fresh
  // verdict; that path needs no special handling here.
  const parsedAmount = /^\d+$/.test(amount.trim()) ? Number.parseInt(amount.trim(), 10) : null;
  const mismatch = confirmState.status === "mismatch" && parsedAmount === confirmState.receivedMinor ? confirmState : null;
  const confirmDisabled = confirmPending || (mismatch !== null && !mismatchAccepted);

  return (
    <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
      <form action={confirmFormAction} aria-busy={confirmPending} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="confirm-amount">Amount received</Label>
          <Input
            id="confirm-amount"
            inputMode="numeric"
            min={0}
            name="amount"
            onChange={(event) => {
              setAmount(event.target.value);
              // The override was granted against the number in the mismatch banner. The moment the
              // admin changes what they are submitting, that grant no longer means anything - it must
              // be given again, against whatever the banner says next.
              setMismatchAccepted(false);
            }}
            required
            step={1}
            type="number"
            value={amount}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-reference">Bank reference</Label>
          <Input
            id="confirm-reference"
            name="reference"
            onChange={(event) => setReference(event.target.value)}
            required
            value={reference}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-note">Note</Label>
          <Textarea id="confirm-note" name="note" onChange={(event) => setNote(event.target.value)} value={note} />
        </div>

        {mismatch ? (
          <div className="space-y-3 border border-error p-4" role="alert">
            <p className="text-[0.8125rem] text-error">
              Received {formatPrice(mismatch.receivedMinor, currency, "en")}, but the order total is{" "}
              {formatPrice(mismatch.expectedMinor, currency, "en")}.
            </p>
            <label className="flex min-h-11 items-center gap-3 text-[0.8125rem]" htmlFor="confirm-accept-mismatch">
              <input
                checked={mismatchAccepted}
                className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                id="confirm-accept-mismatch"
                name="accept-mismatch"
                onChange={(event) => setMismatchAccepted(event.target.checked)}
                type="checkbox"
              />
              Confirm anyway, even though the amount does not match
            </label>
          </div>
        ) : null}

        <Button className="min-h-11" disabled={confirmDisabled} type="submit">
          {confirmPending ? "Confirming…" : "Confirm payment"}
        </Button>

        {confirmState.status === "error" ? (
          <p className="text-[0.8125rem] text-error" role="alert">
            {confirmState.message}
          </p>
        ) : null}
        {/*
          No success message on this form, deliberately. A confirmation completes the order, and
          both decision forms render only while it is pending - so the message would unmount with
          the form that owns it and never be seen. What the admin is left looking at is the
          confirmation record and the new order state, which come from the database. The decline
          twin below IS reachable: "not received" leaves the order pending, so that form stays.
        */}
      </form>

      <form action={declineFormAction} aria-busy={declinePending} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="decline-reason">Reason</Label>
          <Textarea id="decline-reason" name="reason" onChange={(event) => setReason(event.target.value)} required value={reason} />
        </div>
        <fieldset className="space-y-1">
          <legend className="text-[0.8125rem] leading-snug font-medium text-ink">Outcome</legend>
          <label className="flex min-h-11 items-center gap-3 text-sm" htmlFor="decline-outcome-not-received">
            <input
              className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
              defaultChecked
              id="decline-outcome-not-received"
              name="outcome"
              type="radio"
              value="not_received"
            />
            Mark as not received
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm" htmlFor="decline-outcome-cancel">
            <input
              className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
              id="decline-outcome-cancel"
              name="outcome"
              type="radio"
              value="cancel"
            />
            Cancel order
          </label>
        </fieldset>

        <Button className="min-h-11" disabled={declinePending} type="submit" variant="destructive">
          {declinePending ? "Declining…" : "Decline payment"}
        </Button>

        {declineState.status === "error" ? (
          <p className="text-[0.8125rem] text-error" role="alert">
            {declineState.message}
          </p>
        ) : null}
        {declineState.status === "done" ? (
          <p className="text-[0.8125rem] text-success" role="status">
            Payment declined.
          </p>
        ) : null}
      </form>
    </div>
  );
}
