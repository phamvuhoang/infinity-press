"use client";

import { useActionState, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { CouponKind } from "@/lib/commerce/coupon";
import type { AdminCouponDTO } from "@/lib/data/coupons";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
type ScopeOption = { id: string; title: string };

// A datetime-local input reads and writes "YYYY-MM-DDTHH:mm"; coupons.starts_at/ends_at come back
// as a full ISO timestamp in UTC. Slicing keeps this a plain display/edit round-trip with no
// timezone conversion attempted - the input renders those UTC digits as if they were local time,
// and whatever the operator types back is stored as UTC - the same simplicity edition-offer-forms.tsx
// takes with a plain `date` input. The "(UTC)" field labels carry the disclosure the input itself
// cannot make.
function toLocalInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 16) : "";
}

// A checkbox list for one scope table. Books and bundles are two independent scopes (S9 spec 8),
// rendered identically and submitted as two separate UUID arrays - neither is ever derived from the
// other, so a coupon scoped to a book that happens to sit in a bundle does not discount the bundle.
function ScopeFieldset({
  emptyLabel,
  error,
  hint,
  legend,
  name,
  options,
  selected,
}: {
  emptyLabel: string;
  error: string | undefined;
  hint: string;
  legend: string;
  name: string;
  options: ScopeOption[];
  selected: string[];
}) {
  const errorId = `coupon-${name}-error`;
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-2 text-[0.8125rem] font-medium">{legend}</legend>
      <p className="text-[0.8125rem] text-sage-text">{hint}</p>
      {options.length === 0 ? (
        <p className="text-sm text-sage-text">{emptyLabel}</p>
      ) : (
        <div className="grid gap-x-6 sm:grid-cols-2">
          {options.map((option) => (
            <label className="flex min-h-11 items-center gap-3 text-sm" key={option.id}>
              <input
                aria-describedby={error ? errorId : undefined}
                aria-invalid={Boolean(error)}
                className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                defaultChecked={selected.includes(option.id)}
                name={name}
                type="checkbox"
                value={option.id}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{option.title}</span>
            </label>
          ))}
        </div>
      )}
      <FieldError id={errorId} message={error} />
    </fieldset>
  );
}

export function CouponForm({
  action,
  books,
  bundles,
  coupon,
}: {
  action: FormAction;
  books: ScopeOption[];
  bundles: ScopeOption[];
  coupon: AdminCouponDTO | null;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const [kind, setKind] = useState<CouponKind>(coupon?.kind ?? "percent");

  // A coupon that has already been reserved or redeemed cannot have its kind or value changed
  // (EB025, spec 7.2). Disabling here teaches the operator the rule before they submit, rather than
  // after a database error.
  const locked = coupon !== null && coupon.reservedCount + coupon.redeemedCount > 0;

  // Zod reports a bad array element under an indexed path ("bookIds.0"), so the fieldset's own key
  // and any index below it both have to resolve to the one message the fieldset shows.
  const scopeError = (field: string) =>
    state.fieldErrors[field] ?? Object.entries(state.fieldErrors).find(([key]) => key.startsWith(`${field}.`))?.[1];

  return (
    <form action={formAction} className="space-y-6" onReset={(event) => event.preventDefault()}>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="coupon-code">Code</Label>
        <Input
          aria-describedby={state.fieldErrors.code ? "coupon-code-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.code)}
          defaultValue={coupon?.code ?? ""}
          id="coupon-code"
          name="code"
          // The code is never editable once created: a reader may already be holding it, and a
          // renamed code is a different promotion. readOnly (not disabled) so the existing value
          // still submits with the rest of the form.
          readOnly={coupon !== null}
          placeholder="LAUNCH20"
        />
        <FieldError id="coupon-code-error" message={state.fieldErrors.code} />
      </div>

      {locked ? (
        <p className="text-[0.8125rem] text-sage-text" role="status">
          This code has been used, so its value cannot change.
        </p>
      ) : null}

      <div className="min-w-0 space-y-2">
        <Label htmlFor="coupon-kind">Kind</Label>
        <NativeSelect
          aria-describedby={state.fieldErrors.kind ? "coupon-kind-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.kind)}
          disabled={locked}
          id="coupon-kind"
          name={locked ? undefined : "kind"}
          onChange={(event) => setKind(event.target.value as CouponKind)}
          value={kind}
        >
          <option value="percent">Percent off</option>
          <option value="fixed">Fixed amount off</option>
        </NativeSelect>
        {/* Disabling the select above excludes it from FormData, so a locked coupon's kind is
            carried by this hidden field instead. */}
        {locked ? <input name="kind" type="hidden" value={kind} /> : null}
        <FieldError id="coupon-kind-error" message={state.fieldErrors.kind} />
      </div>

      {kind === "percent" ? (
        <div className="min-w-0 space-y-2">
          <Label htmlFor="coupon-percentOff">Percentage off</Label>
          <Input
            aria-describedby={state.fieldErrors.percentOff ? "coupon-percentOff-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.percentOff)}
            defaultValue={coupon?.percentOff ?? ""}
            disabled={locked}
            id="coupon-percentOff"
            max={100}
            min={1}
            name={locked ? undefined : "percentOff"}
            type="number"
          />
          {locked ? <input name="percentOff" type="hidden" value={coupon?.percentOff ?? ""} /> : null}
          <FieldError id="coupon-percentOff-error" message={state.fieldErrors.percentOff} />
        </div>
      ) : (
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Label htmlFor="coupon-amountOffMinor">Amount off (minor units)</Label>
            <Input
              aria-describedby={state.fieldErrors.amountOffMinor ? "coupon-amountOffMinor-error" : undefined}
              aria-invalid={Boolean(state.fieldErrors.amountOffMinor)}
              defaultValue={coupon?.amountOffMinor ?? ""}
              disabled={locked}
              id="coupon-amountOffMinor"
              min={1}
              name={locked ? undefined : "amountOffMinor"}
              type="number"
            />
            {locked ? <input name="amountOffMinor" type="hidden" value={coupon?.amountOffMinor ?? ""} /> : null}
            <FieldError id="coupon-amountOffMinor-error" message={state.fieldErrors.amountOffMinor} />
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="coupon-currency">Currency</Label>
            <Input
              aria-describedby={state.fieldErrors.currency ? "coupon-currency-error" : undefined}
              aria-invalid={Boolean(state.fieldErrors.currency)}
              defaultValue={coupon?.currency ?? ""}
              disabled={locked}
              id="coupon-currency"
              maxLength={3}
              name={locked ? undefined : "currency"}
            />
            {locked ? <input name="currency" type="hidden" value={coupon?.currency ?? ""} /> : null}
            <FieldError id="coupon-currency-error" message={state.fieldErrors.currency} />
          </div>
        </div>
      )}

      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="coupon-startsAt">Starts (UTC)</Label>
          <Input
            aria-describedby={state.fieldErrors.startsAt ? "coupon-startsAt-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.startsAt)}
            defaultValue={toLocalInputValue(coupon?.startsAt ?? null)}
            id="coupon-startsAt"
            name="startsAt"
            type="datetime-local"
          />
          <FieldError id="coupon-startsAt-error" message={state.fieldErrors.startsAt} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="coupon-endsAt">Ends (UTC)</Label>
          <Input
            aria-describedby={state.fieldErrors.endsAt ? "coupon-endsAt-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.endsAt)}
            defaultValue={toLocalInputValue(coupon?.endsAt ?? null)}
            id="coupon-endsAt"
            name="endsAt"
            type="datetime-local"
          />
          <FieldError id="coupon-endsAt-error" message={state.fieldErrors.endsAt} />
        </div>
      </div>

      <label className="flex min-h-11 items-center gap-3 text-sm" htmlFor="coupon-active">
        <input
          aria-describedby={state.fieldErrors.active ? "coupon-active-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.active)}
          className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
          defaultChecked={coupon?.active ?? true}
          id="coupon-active"
          name="active"
          type="checkbox"
        />
        Active
      </label>
      <FieldError id="coupon-active-error" message={state.fieldErrors.active} />

      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="coupon-maxRedemptions">Maximum redemptions (blank means unlimited)</Label>
          <Input
            aria-describedby={state.fieldErrors.maxRedemptions ? "coupon-maxRedemptions-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.maxRedemptions)}
            defaultValue={coupon?.maxRedemptions ?? ""}
            id="coupon-maxRedemptions"
            min={1}
            name="maxRedemptions"
            type="number"
          />
          <FieldError id="coupon-maxRedemptions-error" message={state.fieldErrors.maxRedemptions} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="coupon-maxRedemptionsPerProfile">Maximum redemptions per customer</Label>
          <Input
            aria-describedby={state.fieldErrors.maxRedemptionsPerProfile ? "coupon-maxRedemptionsPerProfile-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.maxRedemptionsPerProfile)}
            defaultValue={coupon?.maxRedemptionsPerProfile ?? 1}
            id="coupon-maxRedemptionsPerProfile"
            min={1}
            name="maxRedemptionsPerProfile"
            type="number"
          />
          <FieldError id="coupon-maxRedemptionsPerProfile-error" message={state.fieldErrors.maxRedemptionsPerProfile} />
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <Label htmlFor="coupon-note">Note</Label>
        <Textarea
          aria-describedby={state.fieldErrors.note ? "coupon-note-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.note)}
          defaultValue={coupon?.note ?? ""}
          id="coupon-note"
          name="note"
        />
        <FieldError id="coupon-note-error" message={state.fieldErrors.note} />
      </div>

      <ScopeFieldset
        emptyLabel="No books yet."
        error={scopeError("bookIds")}
        hint="Selecting nothing here and nothing under Bundles means the code applies to everything."
        legend="Books"
        name="bookIds"
        options={books}
        selected={coupon?.bookIds ?? []}
      />

      <ScopeFieldset
        emptyLabel="No bundles yet."
        error={scopeError("bundleIds")}
        hint="A book selected above does not put its bundles in scope. Select the bundles the code covers here."
        legend="Bundles"
        name="bundleIds"
        options={bundles}
        selected={coupon?.bundleIds ?? []}
      />

      <FormStatus state={state} />
      <SubmitButton pendingLabel={coupon ? "Saving…" : "Creating…"}>{coupon ? "Save coupon" : "Create coupon"}</SubmitButton>
    </form>
  );
}
