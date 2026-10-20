"use client";

import { useActionState, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import { formatPrice } from "@/lib/catalog/price";
import type { AdminBookDTO } from "@/lib/data/books";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;

export function EditionForm({ action, edition }: { action: FormAction; edition: NonNullable<AdminBookDTO["edition"]> }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} onReset={(event) => event.preventDefault()} className="space-y-5">
      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="edition-languageCode">Edition language</Label>
          <NativeSelect defaultValue={edition.languageCode} aria-invalid={Boolean(state.fieldErrors.languageCode)} aria-describedby={state.fieldErrors.languageCode ? "edition-languageCode-error" : undefined} id="edition-languageCode" name="languageCode">
            <option value="vi">Vietnamese (vi)</option>
            <option value="en">English (en)</option>
          </NativeSelect>
          <FieldError id="edition-languageCode-error" message={state.fieldErrors.languageCode} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="edition-isbn">ISBN</Label>
          <Input defaultValue={edition.isbn ?? ""} aria-invalid={Boolean(state.fieldErrors.isbn)} aria-describedby={state.fieldErrors.isbn ? "edition-isbn-error" : undefined} id="edition-isbn" name="isbn" />
          <FieldError id="edition-isbn-error" message={state.fieldErrors.isbn} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="edition-editionNumber">Edition number</Label>
          <Input defaultValue={edition.editionNumber} aria-invalid={Boolean(state.fieldErrors.editionNumber)} aria-describedby={state.fieldErrors.editionNumber ? "edition-editionNumber-error" : undefined} id="edition-editionNumber" min={1} name="editionNumber" type="number" />
          <FieldError id="edition-editionNumber-error" message={state.fieldErrors.editionNumber} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="edition-publicationDate">Publication date</Label>
          <Input defaultValue={edition.publicationDate ?? ""} aria-invalid={Boolean(state.fieldErrors.publicationDate)} aria-describedby={state.fieldErrors.publicationDate ? "edition-publicationDate-error" : undefined} id="edition-publicationDate" name="publicationDate" type="date" />
          <FieldError id="edition-publicationDate-error" message={state.fieldErrors.publicationDate} />
        </div>
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save edition</SubmitButton>
    </form>
  );
}

export function OfferForm({ action, offer }: { action: FormAction; offer: NonNullable<AdminBookDTO["offer"]> }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} onReset={(event) => event.preventDefault()} className="space-y-5">
      <div className="grid min-w-0 gap-5 sm:grid-cols-3">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="offer-marketCode">Market</Label>
          <Input defaultValue={offer.marketCode} aria-invalid={Boolean(state.fieldErrors.marketCode)} aria-describedby={state.fieldErrors.marketCode ? "offer-marketCode-error" : undefined} id="offer-marketCode" maxLength={2} name="marketCode" />
          <FieldError id="offer-marketCode-error" message={state.fieldErrors.marketCode} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="offer-currency">Currency</Label>
          <Input defaultValue={offer.currency} aria-invalid={Boolean(state.fieldErrors.currency)} aria-describedby={state.fieldErrors.currency ? "offer-currency-error" : undefined} id="offer-currency" maxLength={3} name="currency" />
          <FieldError id="offer-currency-error" message={state.fieldErrors.currency} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="offer-priceMinor">Price (minor units)</Label>
          <Input defaultValue={offer.priceMinor} aria-invalid={Boolean(state.fieldErrors.priceMinor)} aria-describedby={state.fieldErrors.priceMinor ? "offer-priceMinor-error" : undefined} id="offer-priceMinor" min={0} name="priceMinor" type="number" />
          <FieldError id="offer-priceMinor-error" message={state.fieldErrors.priceMinor} />
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm" htmlFor="offer-active">
        <input className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest" defaultChecked={offer.active} aria-invalid={Boolean(state.fieldErrors.active)} aria-describedby={state.fieldErrors.active ? "offer-active-error" : undefined} id="offer-active" name="active" type="checkbox" />
        Offer is active
      </label>
      <FieldError id="offer-active-error" message={state.fieldErrors.active} />
      <p className="text-[0.8125rem] text-sage-text">A price of 0 makes the ebook free. Paid prices show as coming soon until payments launch.</p>
      <SaleFields offer={offer} fieldErrors={state.fieldErrors} />
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save offer</SubmitButton>
    </form>
  );
}

// datetime-local reads and writes "YYYY-MM-DDTHH:mm"; the stored value is a UTC ISO timestamp.
// Slicing shows those UTC digits as they are, the same round-trip the coupon editor makes, and the
// "(UTC)" labels carry the disclosure the input cannot.
function toUtcInputValue(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 16) : "";
}

function utcLabel(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// S19: a percent or fixed sale on the book's list price, optionally windowed. The state line is
// computed from the saved row by offer_effective_price_minor, the function checkout uses.
function SaleFields({ offer, fieldErrors }: { offer: NonNullable<AdminBookDTO["offer"]>; fieldErrors: AdminFormState["fieldErrors"] }) {
  const sale = offer.sale;
  // A field the chosen kind does not use is disabled, so it is neither submitted nor able to block
  // the submit with its own min/max (the schema nulls it again on the server).
  const [kind, setKind] = useState<string>(sale?.kind ?? "none");
  const field = (name: string) => ({
    "aria-invalid": Boolean(fieldErrors[name]),
    "aria-describedby": fieldErrors[name] ? `offer-${name}-error` : undefined,
    id: `offer-${name}`,
    name,
  });
  const state = {
    none: "No sale.",
    running: `Sale running: buyers pay ${formatPrice(offer.effectivePriceMinor, offer.currency, "en")}${sale?.endsAt ? ` until ${utcLabel(sale.endsAt)}` : ""}.`,
    scheduled: `Sale scheduled from ${sale?.startsAt ? utcLabel(sale.startsAt) : ""}.`,
    ended: "Sale ended. Buyers pay the list price.",
  }[offer.saleState];

  return (
    <fieldset className="min-w-0 space-y-4 border-t border-hairline pt-5">
      <legend className="text-sm font-medium">Sale</legend>
      <div className="grid min-w-0 gap-5 sm:grid-cols-3">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="offer-saleKind">Discount</Label>
          <NativeSelect onChange={(event) => setKind(event.target.value)} value={kind} {...field("saleKind")}>
            <option value="none">No sale</option>
            <option value="percent">Percent off</option>
            <option value="fixed">Amount off</option>
          </NativeSelect>
          <FieldError id="offer-saleKind-error" message={fieldErrors.saleKind} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="offer-salePercentOff">Percentage off</Label>
          <Input defaultValue={sale?.percentOff ?? ""} disabled={kind !== "percent"} max={99} min={1} type="number" {...field("salePercentOff")} />
          <FieldError id="offer-salePercentOff-error" message={fieldErrors.salePercentOff} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="offer-saleAmountOffMinor">Amount off (minor units)</Label>
          <Input defaultValue={sale?.amountOffMinor ?? ""} disabled={kind !== "fixed"} min={1} type="number" {...field("saleAmountOffMinor")} />
          <FieldError id="offer-saleAmountOffMinor-error" message={fieldErrors.saleAmountOffMinor} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="offer-saleStartsAt">Starts (UTC)</Label>
          <Input defaultValue={toUtcInputValue(sale?.startsAt ?? null)} disabled={kind === "none"} type="datetime-local" {...field("saleStartsAt")} />
          <FieldError id="offer-saleStartsAt-error" message={fieldErrors.saleStartsAt} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="offer-saleEndsAt">Ends (UTC)</Label>
          <Input defaultValue={toUtcInputValue(sale?.endsAt ?? null)} disabled={kind === "none"} type="datetime-local" {...field("saleEndsAt")} />
          <FieldError id="offer-saleEndsAt-error" message={fieldErrors.saleEndsAt} />
        </div>
      </div>
      <p className="text-[0.8125rem] text-sage-text">
        {state} The sale price is what checkout charges, and a coupon applies on top of it. Leave Starts or Ends blank for no limit.
      </p>
    </fieldset>
  );
}
