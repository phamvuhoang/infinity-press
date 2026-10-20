"use client";

import { useActionState } from "react";
import { type Locale } from "@/lib/i18n/config";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

// Keep operator edits when a Server Action resolves with validation errors.
// These editor forms deliberately preserve values on both success and failure.
type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;

export function EntityBaseForm({
  action,
  defaults,
  showStatus,
  submitLabel,
}: {
  action: FormAction;
  // acceptsQuestions is rendered only when given: the author editor passes it, series and topics do not.
  defaults: { canonicalSlug: string; name: string; status: string; acceptsQuestions?: boolean };
  showStatus: boolean;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} onReset={(event) => event.preventDefault()} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="canonicalSlug">Canonical slug</Label>
        <Input defaultValue={defaults.canonicalSlug} id="canonicalSlug" name="canonicalSlug"
          aria-invalid={Boolean(state.fieldErrors.canonicalSlug)}
          aria-describedby={state.fieldErrors.canonicalSlug ? "canonicalSlug-error" : undefined} required />
        <FieldError id="canonicalSlug-error" message={state.fieldErrors.canonicalSlug} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input defaultValue={defaults.name} id="name" name="name"
          aria-invalid={Boolean(state.fieldErrors.name)}
          aria-describedby={state.fieldErrors.name ? "name-error" : undefined} required />
        <FieldError id="name-error" message={state.fieldErrors.name} />
      </div>
      {showStatus ? (
        <div className="space-y-2">
          <Label htmlFor="status">Status</Label>
          <NativeSelect defaultValue={defaults.status} id="status" name="status"
          aria-invalid={Boolean(state.fieldErrors.status)}
          aria-describedby={state.fieldErrors.status ? "status-error" : undefined}>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </NativeSelect>
          <FieldError id="status-error" message={state.fieldErrors.status} />
        </div>
      ) : null}
      {defaults.acceptsQuestions !== undefined ? (
        <div className="flex items-start gap-3">
          <input className="mt-1 size-4" defaultChecked={defaults.acceptsQuestions} id="acceptsQuestions" name="acceptsQuestions" type="checkbox" />
          <Label htmlFor="acceptsQuestions">
            Accepts reader questions
            <span className="mt-1 block text-[0.8125rem] font-normal text-ink-soft">
              Off by default for new authors. Off hides &ldquo;Ask the editors&rdquo; on this author&rsquo;s books and refuses new questions; turn it on only when the editors will answer. Replies are shown as the editors&rsquo;, never as the author&rsquo;s.
            </span>
          </Label>
        </div>
      ) : null}
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
    </form>
  );
}

export function EntityLocalizationForm({
  action,
  locale,
  defaults,
  showQuote = false,
}: {
  action: FormAction;
  locale: Locale;
  defaults: { slug: string; name: string; description: string | null; quote: string | null } | null;
  // Authors only: board 1e sets a pull quote above the description in the home page band.
  showQuote?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const suffix = `(${locale})`;

  return (
    <form action={formAction} onReset={(event) => event.preventDefault()} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`slug-${locale}`}>Slug {suffix}</Label>
          <Input defaultValue={defaults?.slug ?? ""} id={`slug-${locale}`} name="slug"
            aria-invalid={Boolean(state.fieldErrors.slug)}
            aria-describedby={state.fieldErrors.slug ? `slug-${locale}-error` : undefined} required />
          <FieldError id={`slug-${locale}-error`} message={state.fieldErrors.slug} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`name-${locale}`}>Name {suffix}</Label>
          <Input defaultValue={defaults?.name ?? ""} id={`name-${locale}`} name="name"
            aria-invalid={Boolean(state.fieldErrors.name)}
            aria-describedby={state.fieldErrors.name ? `name-${locale}-error` : undefined} required />
          <FieldError id={`name-${locale}-error`} message={state.fieldErrors.name} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`description-${locale}`}>Description {suffix}</Label>
        <Textarea defaultValue={defaults?.description ?? ""} id={`description-${locale}`} name="description"
            aria-invalid={Boolean(state.fieldErrors.description)}
            aria-describedby={state.fieldErrors.description ? `description-${locale}-error` : undefined} rows={5} />
        <FieldError id={`description-${locale}-error`} message={state.fieldErrors.description} />
      </div>
      {showQuote ? (
        <div className="space-y-2">
          <Label htmlFor={`quote-${locale}`}>Pull quote {suffix}</Label>
          <Textarea defaultValue={defaults?.quote ?? ""} id={`quote-${locale}`} name="quote"
            aria-invalid={Boolean(state.fieldErrors.quote)}
            aria-describedby={state.fieldErrors.quote ? `quote-${locale}-error` : undefined} rows={3} />
          <p className="text-[0.8125rem] text-sage-text">
            One or two sentences in the author&apos;s own voice. Shown above the description on the home page.
          </p>
          <FieldError id={`quote-${locale}-error`} message={state.fieldErrors.quote} />
        </div>
      ) : null}
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{`Save ${locale} copy`}</SubmitButton>
    </form>
  );
}
