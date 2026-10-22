"use client";

import { useActionState, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { formatContributors, initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import { formatPrice } from "@/lib/catalog/price";
import type { AdminEditionDTO, AdminOfferDTO, PricingDefaultDTO } from "@/lib/data/admin-editions";
import type { ContentLanguageOption } from "@/lib/i18n/settings";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;

function LanguageSelect({
  languages,
  defaultValue,
  disabled,
  error,
  id,
}: {
  languages: ContentLanguageOption[];
  defaultValue: string;
  disabled?: boolean;
  error?: string;
  id: string;
}) {
  return (
    <>
      <NativeSelect
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={Boolean(error)}
        defaultValue={defaultValue}
        disabled={disabled}
        id={id}
        name="languageCode"
      >
        {languages.map((language) => (
          <option key={language.code} value={language.code}>
            {`${language.name} (${language.code})`}
          </option>
        ))}
      </NativeSelect>
      <FieldError id={`${id}-error`} message={error} />
    </>
  );
}

// A new edition of this work in another language. The admin picks the language; the edition opens
// on its own page for credits, offers and the EPUB.
export function CreateEditionForm({ action, languages }: { action: FormAction; languages: ContentLanguageOption[] }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} className="space-y-4" onReset={(event) => event.preventDefault()}>
      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="new-edition-languageCode">Language</Label>
          <LanguageSelect
            defaultValue={languages[0]?.code ?? "en"}
            error={state.fieldErrors.languageCode}
            id="new-edition-languageCode"
            languages={languages}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="new-edition-editionNumber">Edition number (optional)</Label>
          <Input aria-describedby={state.fieldErrors.editionNumber ? "new-edition-editionNumber-error" : undefined} aria-invalid={Boolean(state.fieldErrors.editionNumber)} id="new-edition-editionNumber" min={1} name="editionNumber" type="number" />
          <FieldError id="new-edition-editionNumber-error" message={state.fieldErrors.editionNumber} />
        </div>
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Creating…">Add edition</SubmitButton>
    </form>
  );
}

export function EditionForm({
  action,
  edition,
  languages,
}: {
  action: FormAction;
  edition: AdminEditionDTO;
  languages: ContentLanguageOption[];
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const field = (name: string) => ({
    "aria-invalid": Boolean(state.fieldErrors[name]),
    "aria-describedby": state.fieldErrors[name] ? `edition-${name}-error` : undefined,
    id: `edition-${name}`,
    name,
  });

  return (
    <form action={formAction} onReset={(event) => event.preventDefault()} className="space-y-5">
      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="edition-languageCode">Edition language</Label>
          <LanguageSelect
            defaultValue={edition.languageCode}
            disabled={edition.identityLocked}
            error={state.fieldErrors.languageCode}
            id="edition-languageCode"
            languages={languages}
          />
          {edition.identityLocked ? (
            <p className="text-[0.8125rem] text-sage-text">
              This edition has orders or readers, so its language is fixed. Create a new edition if it was entered wrongly.
            </p>
          ) : null}
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="edition-isbn">ISBN</Label>
          <Input defaultValue={edition.isbn ?? ""} {...field("isbn")} />
          <FieldError id="edition-isbn-error" message={state.fieldErrors.isbn} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="edition-editionNumber">Edition number</Label>
          <Input defaultValue={edition.editionNumber} min={1} type="number" {...field("editionNumber")} />
          <FieldError id="edition-editionNumber-error" message={state.fieldErrors.editionNumber} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="edition-publicationDate">Publication date</Label>
          <Input defaultValue={edition.publicationDate ?? ""} type="date" {...field("publicationDate")} />
          <FieldError id="edition-publicationDate-error" message={state.fieldErrors.publicationDate} />
        </div>
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="edition-contributors">Credits</Label>
        <Textarea defaultValue={formatContributors(edition.contributors)} rows={3} {...field("contributors")} />
        <p className="text-[0.8125rem] text-sage-text">One per line, like &ldquo;translator: Jane Doe&rdquo;. Shown on the book page.</p>
        <FieldError id="edition-contributors-error" message={state.fieldErrors.contributors} />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="edition-introduction">Translation introduction</Label>
        <Textarea defaultValue={edition.introduction ?? ""} rows={5} {...field("introduction")} />
        <FieldError id="edition-introduction-error" message={state.fieldErrors.introduction} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save edition</SubmitButton>
    </form>
  );
}

// A button that makes this edition (or this offer) the default. Shown only while it is not already.
export function DefaultButtonForm({ action, label, pendingLabel }: { action: FormAction; label: string; pendingLabel: string }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  return (
    <form action={formAction} className="space-y-2">
      <FormStatus state={state} />
      <SubmitButton pendingLabel={pendingLabel}>{label}</SubmitButton>
    </form>
  );
}

// A new offer. The price starts empty, or from the admin's template for this language when one
// exists; an unset price is refused rather than becoming a free offer.
export function CreateOfferForm({ action, defaults }: { action: FormAction; defaults: PricingDefaultDTO[] }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const prefill = defaults[0];

  return (
    <form action={formAction} className="space-y-4" onReset={(event) => event.preventDefault()}>
      <div className="grid min-w-0 gap-5 sm:grid-cols-3">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="new-offer-marketCode">Market</Label>
          <Input aria-describedby={state.fieldErrors.marketCode ? "new-offer-marketCode-error" : undefined} aria-invalid={Boolean(state.fieldErrors.marketCode)} defaultValue={prefill?.marketCode ?? ""} id="new-offer-marketCode" maxLength={2} name="marketCode" />
          <FieldError id="new-offer-marketCode-error" message={state.fieldErrors.marketCode} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="new-offer-currency">Currency</Label>
          <Input aria-describedby={state.fieldErrors.currency ? "new-offer-currency-error" : undefined} aria-invalid={Boolean(state.fieldErrors.currency)} defaultValue={prefill?.currency ?? ""} id="new-offer-currency" maxLength={3} name="currency" />
          <FieldError id="new-offer-currency-error" message={state.fieldErrors.currency} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="new-offer-priceMinor">Price (minor units)</Label>
          <Input aria-describedby={state.fieldErrors.priceMinor ? "new-offer-priceMinor-error" : undefined} aria-invalid={Boolean(state.fieldErrors.priceMinor)} defaultValue={prefill?.priceMinor ?? ""} id="new-offer-priceMinor" min={0} name="priceMinor" type="number" />
          <FieldError id="new-offer-priceMinor-error" message={state.fieldErrors.priceMinor} />
        </div>
      </div>
      <p className="text-[0.8125rem] text-sage-text">
        {prefill
          ? "Prefilled from the language's pricing template; change it freely. Existing offers are never touched."
          : "There is no pricing template for this language."}{" "}
        Enter 0 for a free edition. Minor units: 500 JPY is ¥500, 500 USD is $5.00.
      </p>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Adding…">Add offer</SubmitButton>
    </form>
  );
}

export function OfferForm({ action, offer }: { action: FormAction; offer: AdminOfferDTO }) {
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
      <p className="text-[0.8125rem] text-sage-text">A price of 0 makes the edition free.</p>
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
function SaleFields({ offer, fieldErrors }: { offer: AdminOfferDTO; fieldErrors: AdminFormState["fieldErrors"] }) {
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

// The whole-book sample switch. Enabled while the edition is free, and while it is already on,
// so an admin can always close it after the price changes.
export function SampleFullForm({ action, sampleFull, canOpen }: { action: FormAction; sampleFull: boolean; canOpen: boolean }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const enabled = canOpen || sampleFull;
  return (
    <form action={formAction} className="space-y-2">
      <FormStatus state={state} />
      <label className="flex min-h-11 items-center gap-3 text-sm" htmlFor="sample-full">
        <input className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest" defaultChecked={sampleFull} disabled={!enabled} id="sample-full" name="full" type="checkbox" />
        Mở toàn bộ bản này cho đọc thử
      </label>
      {enabled ? <SubmitButton pendingLabel="Saving…">Save sample</SubmitButton> : <p className="text-sm text-ink-soft">Only a free edition can be opened in full.</p>}
    </form>
  );
}
