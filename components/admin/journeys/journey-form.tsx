"use client";

import { useActionState, useState } from "react";

import { createJourneyAction } from "@/app/admin/journeys/actions";
import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { Locale } from "@/lib/i18n/config";

export type JourneyBookOption = { id: string; title: string; editions: { id: string; label: string }[] };

// A journey belongs to one book and one of its editions; createJourney rejects a mismatched pair.
export function JourneyCreateForm({ books }: { books: JourneyBookOption[] }) {
  const [state, formAction] = useActionState(createJourneyAction, initialAdminFormState);
  const [bookId, setBookId] = useState("");
  const editions = books.find((book) => book.id === bookId)?.editions ?? [];

  return (
    <form action={formAction} className="space-y-5" onReset={(event) => event.preventDefault()}>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="journey-new-bookId">Book</Label>
        <NativeSelect id="journey-new-bookId" name="bookId" onChange={(event) => setBookId(event.target.value)} required value={bookId}>
          <option value="">Choose a book</option>
          {books.map((book) => (
            <option key={book.id} value={book.id}>
              {book.title}
            </option>
          ))}
        </NativeSelect>
        <FieldError message={state.fieldErrors.bookId} />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="journey-new-editionId">Edition</Label>
        <NativeSelect defaultValue="" id="journey-new-editionId" key={bookId} name="editionId" required>
          <option value="">Choose an edition</option>
          {editions.map((edition) => (
            <option key={edition.id} value={edition.id}>
              {edition.label}
            </option>
          ))}
        </NativeSelect>
        <FieldError message={state.fieldErrors.editionId} />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="journey-new-slug">Slug</Label>
        <Input id="journey-new-slug" name="slug" pattern="[a-z0-9\-]{3,64}" required />
        <p className="text-[0.8125rem] text-sage-text">Lowercase letters, digits, and hyphens. Used in the journey URL.</p>
        <FieldError message={state.fieldErrors.slug} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Creating…">Create journey</SubmitButton>
    </form>
  );
}

export function JourneyLocalizationForm({
  locale,
  localization,
  action,
}: {
  locale: Locale;
  localization: { title: string; summary: string } | null;
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  return (
    <form action={formAction} aria-label={`Journey ${locale}`} className="min-w-0 space-y-4" onReset={(event) => event.preventDefault()}>
      <div className="min-w-0 space-y-2">
        <Label htmlFor={`journey-title-${locale}`}>{`Title (${locale})`}</Label>
        <Input defaultValue={localization?.title ?? ""} id={`journey-title-${locale}`} name="title" required />
        <FieldError message={state.fieldErrors.title} />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor={`journey-summary-${locale}`}>{`Summary (${locale})`}</Label>
        <Textarea defaultValue={localization?.summary ?? ""} id={`journey-summary-${locale}`} name="summary" rows={3} />
        <FieldError message={state.fieldErrors.summary} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11" pendingLabel="Saving…">{`Save ${locale} journey text`}</SubmitButton>
    </form>
  );
}
