"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { retailers, type Retailer } from "@/lib/analytics/browser";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { AdminRetailLinkDTO } from "@/lib/data/books";

type RetailLinkDraft = { retailer: Retailer; label: string; url: string; priceMinor: string; currency: string; active: boolean };
type Row = { key: string } & RetailLinkDraft;

// Matches the schema's .max(10): the action clamps linkCount to the same cap.
const maxRows = 10;

const retailerNames: Record<Retailer, string> = { shopee: "Shopee", fahasa: "Fahasa", tiki: "Tiki", other: "Other" };

const toRow = (link: AdminRetailLinkDTO): Row => ({
  key: link.id,
  retailer: link.retailer,
  label: link.label ?? "",
  url: link.url,
  priceMinor: link.priceMinor === null ? "" : String(link.priceMinor),
  currency: link.currency ?? "",
  active: link.active,
});

// Editable rows for the paperback retailers. The submitted list IS the stored order -
// admin_set_book_retail_links replaces the whole set and numbers it from the array - so field names
// are re-indexed from row order on every render (links[0].url, links[1].url, ...): removing or
// moving a row never leaves a gap or posts a stale index. The label field exists only for "Other",
// and an unmounted input posts nothing, so a leftover label cannot reach a named retailer.
//
// Move up / Move down / Remove follow the related-books picker's rules: each name says WHICH row it
// acts on, focus follows the row that moved (a button that becomes disabled at the boundary would
// otherwise drop focus to the document body), and a live region announces the result.
export function RetailLinksForm({
  action,
  links,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  links: AdminRetailLinkDTO[];
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const [rows, setRows] = useState<Row[]>(() => links.map(toRow));
  const [announcement, setAnnouncement] = useState("");
  const nextKey = useRef(0);
  const pendingFocus = useRef<string | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement | null>());

  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    controls.current.get(key)?.focus();
  }, [rows]);

  const update = (key: string, patch: Partial<RetailLinkDraft>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  function moveBy(index: number, offset: -1 | 1) {
    const target = index + offset;
    const { key } = rows[index];
    setRows((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    // At the boundary the pressed button is about to be disabled, so hand focus to the other one.
    const atBoundary = target === 0 || target === rows.length - 1;
    const direction = offset === -1 ? "up" : "down";
    pendingFocus.current = `${key}:${atBoundary ? (direction === "up" ? "down" : "up") : direction}`;
    setAnnouncement(`Moved row ${index + 1} to position ${target + 1} of ${rows.length}.`);
  }

  return (
    <form action={formAction} className="space-y-5">
      <input name="linkCount" type="hidden" value={rows.length} />
      {rows.length === 0 ? <p className="text-sm text-sage-text">No paperback retailers yet.</p> : null}
      <ol className="min-w-0 border-t border-sand">
        {rows.map((row, index) => {
          const n = index + 1;
          const field = (name: string) => `links[${index}].${name}`;
          const error = (name: string) => state.fieldErrors[`links.${index}.${name}`];
          const id = (name: string) => `retail-${row.key}-${name}`;
          return (
            <li aria-label={`Paperback retailer row ${n} of ${rows.length}`} className="min-w-0 space-y-3 border-b border-sand py-4" key={row.key}>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor={id("retailer")}>Retailer</Label>
                  <NativeSelect
                    id={id("retailer")}
                    name={field("retailer")}
                    onChange={(event) => update(row.key, { retailer: event.target.value as Retailer })}
                    value={row.retailer}
                  >
                    {retailers.map((retailer) => (
                      <option key={retailer} value={retailer}>
                        {retailerNames[retailer]}
                      </option>
                    ))}
                  </NativeSelect>
                  <FieldError message={error("retailer")} />
                </div>
                {row.retailer === "other" ? (
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor={id("label")}>Label</Label>
                    <Input
                      aria-describedby={error("label") ? id("label-error") : undefined}
                      aria-invalid={Boolean(error("label"))}
                      id={id("label")}
                      maxLength={80}
                      name={field("label")}
                      onChange={(event) => update(row.key, { label: event.target.value })}
                      value={row.label}
                    />
                    <FieldError id={id("label-error")} message={error("label")} />
                  </div>
                ) : null}
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor={id("url")}>URL</Label>
                <Input
                  aria-describedby={error("url") ? id("url-error") : undefined}
                  aria-invalid={Boolean(error("url"))}
                  id={id("url")}
                  inputMode="url"
                  name={field("url")}
                  onChange={(event) => update(row.key, { url: event.target.value })}
                  placeholder="https://"
                  value={row.url}
                />
                <FieldError id={id("url-error")} message={error("url")} />
              </div>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor={id("priceMinor")}>Price (minor units)</Label>
                  <Input
                    aria-describedby={error("priceMinor") ? id("priceMinor-error") : undefined}
                    aria-invalid={Boolean(error("priceMinor"))}
                    id={id("priceMinor")}
                    inputMode="numeric"
                    name={field("priceMinor")}
                    onChange={(event) => update(row.key, { priceMinor: event.target.value })}
                    value={row.priceMinor}
                  />
                  <FieldError id={id("priceMinor-error")} message={error("priceMinor")} />
                </div>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor={id("currency")}>Currency</Label>
                  <Input
                    aria-describedby={error("currency") ? id("currency-error") : undefined}
                    aria-invalid={Boolean(error("currency"))}
                    id={id("currency")}
                    maxLength={3}
                    name={field("currency")}
                    onChange={(event) => update(row.key, { currency: event.target.value.toUpperCase() })}
                    value={row.currency}
                  />
                  <FieldError id={id("currency-error")} message={error("currency")} />
                </div>
              </div>
              <label className="flex min-h-11 items-center gap-3 text-sm" htmlFor={id("active")}>
                <input
                  checked={row.active}
                  className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                  id={id("active")}
                  name={field("active")}
                  onChange={(event) => update(row.key, { active: event.target.checked })}
                  type="checkbox"
                />
                Active
              </label>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  aria-label={`Move row ${n} up`}
                  disabled={index === 0}
                  onClick={() => moveBy(index, -1)}
                  ref={(node: HTMLButtonElement | null) => {
                    controls.current.set(`${row.key}:up`, node);
                  }}
                  type="button"
                  variant="ghost"
                >
                  Move up
                </Button>
                <Button
                  aria-label={`Move row ${n} down`}
                  disabled={index === rows.length - 1}
                  onClick={() => moveBy(index, 1)}
                  ref={(node: HTMLButtonElement | null) => {
                    controls.current.set(`${row.key}:down`, node);
                  }}
                  type="button"
                  variant="ghost"
                >
                  Move down
                </Button>
                <Button
                  aria-label={`Remove row ${n}`}
                  onClick={() => {
                    setRows((current) => current.filter((value) => value.key !== row.key));
                    setAnnouncement(`Removed row ${n}.`);
                  }}
                  type="button"
                  variant="ghost"
                >
                  Remove
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only" data-testid="retail-links-announcement" role="status">
        {announcement}
      </p>
      <Button
        disabled={rows.length >= maxRows}
        onClick={() => {
          nextKey.current += 1;
          setRows((current) => [
            ...current,
            { key: `new-${nextKey.current}`, retailer: "shopee", label: "", url: "", priceMinor: "", currency: "VND", active: true },
          ]);
          setAnnouncement(`Added row ${rows.length + 1}.`);
        }}
        type="button"
        variant="outline"
      >
        Add retailer
      </Button>
      <FieldError message={state.fieldErrors.links} />
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save paperback retailers</SubmitButton>
    </form>
  );
}
