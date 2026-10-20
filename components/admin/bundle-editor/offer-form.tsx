"use client";

import { useActionState, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { AdminBundleOfferDTO } from "@/lib/data/bundles";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;

// A bundle is priced per (market, currency), and admin_set_bundle_offer upserts on exactly that
// key. So an existing row's market and currency are its identity, not editable fields: retyping
// them would insert a SECOND offer and leave the first one live on the storefront but invisible
// here. They are posted as hidden values and shown as text; a genuinely new market is added
// through the explicit form below, where the free-text fields belong.
function ExistingOfferForm({ action, offer }: { action: FormAction; offer: AdminBundleOfferDTO }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const key = `${offer.marketCode}/${offer.currency}`;
  const priceId = `bundle-offer-${offer.id}-priceMinor`;
  const activeId = `bundle-offer-${offer.id}-active`;

  return (
    <form action={formAction} className="space-y-4 border-b border-sand pb-6" onReset={(event) => event.preventDefault()}>
      <input name="marketCode" type="hidden" value={offer.marketCode} />
      <input name="currency" type="hidden" value={offer.currency} />
      <div className="grid min-w-0 gap-5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-end">
        <p className="text-sm">
          <span className="block text-[0.6875rem] tracking-[0.08em] text-sage-text uppercase">Market &amp; currency</span>
          <span className="font-medium">{key}</span>
        </p>
        <div className="min-w-0 space-y-2">
          <Label htmlFor={priceId}>{`Price for ${key} (minor units)`}</Label>
          <Input
            aria-describedby={state.fieldErrors.priceMinor ? `${priceId}-error` : undefined}
            aria-invalid={Boolean(state.fieldErrors.priceMinor)}
            defaultValue={offer.priceMinor}
            id={priceId}
            min={0}
            name="priceMinor"
            type="number"
          />
          <FieldError id={`${priceId}-error`} message={state.fieldErrors.priceMinor} />
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm" htmlFor={activeId}>
        <input
          className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
          defaultChecked={offer.active}
          id={activeId}
          name="active"
          type="checkbox"
        />
        {`${key} offer is active`}
      </label>
      {/* marketCode and currency are posted as hidden values, so a schema error on either is a
          tampered post rather than a typo - it still belongs somewhere the operator can see it. */}
      <FieldError message={state.fieldErrors.marketCode ?? state.fieldErrors.currency} />
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{`Save ${key} offer`}</SubmitButton>
    </form>
  );
}

function NewOfferForm({ action }: { action: FormAction }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} className="space-y-4" onReset={(event) => event.preventDefault()}>
      <div className="grid min-w-0 gap-5 sm:grid-cols-3">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="bundle-new-offer-marketCode">New offer market</Label>
          <Input
            aria-describedby={state.fieldErrors.marketCode ? "bundle-new-offer-marketCode-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.marketCode)}
            defaultValue="VN"
            id="bundle-new-offer-marketCode"
            maxLength={2}
            name="marketCode"
          />
          <FieldError id="bundle-new-offer-marketCode-error" message={state.fieldErrors.marketCode} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="bundle-new-offer-currency">New offer currency</Label>
          <Input
            aria-describedby={state.fieldErrors.currency ? "bundle-new-offer-currency-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.currency)}
            defaultValue="VND"
            id="bundle-new-offer-currency"
            maxLength={3}
            name="currency"
          />
          <FieldError id="bundle-new-offer-currency-error" message={state.fieldErrors.currency} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="bundle-new-offer-priceMinor">New offer price (minor units)</Label>
          <Input
            aria-describedby={state.fieldErrors.priceMinor ? "bundle-new-offer-priceMinor-error" : undefined}
            aria-invalid={Boolean(state.fieldErrors.priceMinor)}
            id="bundle-new-offer-priceMinor"
            min={0}
            name="priceMinor"
            type="number"
          />
          <FieldError id="bundle-new-offer-priceMinor-error" message={state.fieldErrors.priceMinor} />
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm" htmlFor="bundle-new-offer-active">
        <input
          className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
          defaultChecked
          id="bundle-new-offer-active"
          name="active"
          type="checkbox"
        />
        New offer is active
      </label>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Adding…">Add offer</SubmitButton>
    </form>
  );
}

export function BundleOfferForm({ action, offers }: { action: FormAction; offers: AdminBundleOfferDTO[] }) {
  // The add form is hidden until asked for when the bundle already has a price: adding a market is
  // the rare case, and an always-open free-text market field is what invites the accidental second
  // row this design exists to prevent.
  const [adding, setAdding] = useState(offers.length === 0);

  return (
    <div className="min-w-0 space-y-6">
      {offers.length === 0 ? (
        <p className="text-sm text-sage-text">This bundle has no price yet. A bundle cannot be published without an active offer.</p>
      ) : (
        offers.map((offer) => <ExistingOfferForm action={action} key={offer.id} offer={offer} />)
      )}
      <p className="text-[0.8125rem] text-sage-text">
        A bundle price is never prorated for books the buyer already owns. Deactivating every offer takes the bundle below the
        publication rules.
      </p>
      {adding ? (
        <NewOfferForm action={action} />
      ) : (
        <Button onClick={() => setAdding(true)} type="button" variant="outline">
          Add another market
        </Button>
      )}
    </div>
  );
}
