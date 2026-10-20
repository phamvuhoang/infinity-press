"use client";

import { useActionState } from "react";

import type { CouponFormState } from "@/app/[lang]/(account)/checkout/[orderId]/coupon-actions";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fillTemplate } from "@/lib/i18n/format";

type Copy = {
  legend: string;
  label: string;
  apply: string;
  applying: string;
  remove: string;
  removing: string;
  subtotal: string;
  discount: string;
  applied: string;
  invalid: string;
  rateLimited: string;
  unavailable: string;
};

type Action = (state: CouponFormState, formData: FormData) => Promise<CouponFormState>;

const initial: CouponFormState = { status: "idle" };

// The reader's code field (S8 spec 7.1). A code that is already on the order is not editable: it is
// removed and a different one entered, which is also what keeps "one coupon per order" true without
// the UI having to know anything about reservations.
export function CouponForm({
  appliedCode,
  applyAction,
  copy,
  removeAction,
}: {
  appliedCode: string | null;
  applyAction: Action;
  copy: Copy;
  removeAction: Action;
}) {
  const [applyState, apply] = useActionState(applyAction, initial);
  const [removeState, remove] = useActionState(removeAction, initial);
  const message =
    applyState.status === "invalid"
      ? copy.invalid
      : applyState.status === "rateLimited"
        ? copy.rateLimited
        : applyState.status === "unavailable" || removeState.status === "unavailable"
          ? copy.unavailable
          : null;

  return (
    <section aria-label={copy.legend} className="mt-6 border-t border-hairline pt-6">
      {appliedCode ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status">{fillTemplate(copy.applied, { code: appliedCode })}</p>
          <form action={remove}>
            <SubmitButton pendingLabel={copy.removing}>{copy.remove}</SubmitButton>
          </form>
        </div>
      ) : (
        <form action={apply} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="coupon-code">{copy.label}</Label>
            <Input autoCapitalize="characters" autoComplete="off" className="min-h-11" id="coupon-code" name="code" spellCheck={false} />
          </div>
          <SubmitButton className="min-h-11" pendingLabel={copy.applying}>
            {copy.apply}
          </SubmitButton>
        </form>
      )}
      {message ? (
        <p className="mt-3 text-sm text-error" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}
