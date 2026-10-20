"use client";

import { useActionState } from "react";
import { type Locale } from "@/lib/i18n/config";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import {
  KnowledgeBlockEditor,
  type KnowledgeBookOption,
  type KnowledgeIdeaOption,
} from "@/components/admin/knowledge/knowledge-block-editor";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { AdminArticleLocalizationDTO, AdminIdeaLocalizationDTO } from "@/lib/data/admin-knowledge";

type Field = { name: string; label: string; value: string; multiline?: boolean; hint?: string };

// One language's content: the idea's question and short answer (or the article's title and
// excerpt), its slug, and its typed body blocks. The locale is bound by the page into the action.
// Block drafts live in the editor's own state, so a failed save keeps every unsaved change.
export function KnowledgeLocalizationForm({
  kind,
  entityId,
  locale,
  localization,
  action,
  books,
  ideas,
}: {
  kind: "idea" | "article";
  entityId: string;
  locale: Locale;
  localization: AdminIdeaLocalizationDTO | AdminArticleLocalizationDTO | null;
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  books: KnowledgeBookOption[];
  ideas: KnowledgeIdeaOption[];
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const idea = localization && "question" in localization ? localization : null;
  const article = localization && "title" in localization ? localization : null;

  const fields: Field[] =
    kind === "idea"
      ? [
          { name: "question", label: "Question", value: idea?.question ?? "" },
          {
            name: "shortAnswer",
            label: "Short answer",
            value: idea?.shortAnswer ?? "",
            multiline: true,
            hint: "Shown above the body and used as the page's FAQ answer.",
          },
          { name: "slug", label: "Slug", value: localization?.slug ?? "" },
        ]
      : [
          { name: "title", label: "Title", value: article?.title ?? "" },
          { name: "excerpt", label: "Excerpt", value: article?.excerpt ?? "", multiline: true },
          { name: "slug", label: "Slug", value: localization?.slug ?? "" },
        ];

  return (
    <form action={formAction} className="min-w-0 space-y-5" onReset={(event) => event.preventDefault()}>
      {fields.map((field) => {
        const id = `knowledge-${field.name}-${locale}`;
        const error = state.fieldErrors[field.name];
        const describedBy = [field.hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
        return (
          <div className="min-w-0 space-y-2" key={field.name}>
            <Label htmlFor={id}>{`${field.label} (${locale})`}</Label>
            {field.multiline ? (
              <Textarea aria-describedby={describedBy} aria-invalid={Boolean(error)} defaultValue={field.value} id={id} name={field.name} required rows={3} />
            ) : (
              <Input aria-describedby={describedBy} aria-invalid={Boolean(error)} defaultValue={field.value} id={id} name={field.name} required />
            )}
            {field.hint ? (
              <p className="text-[0.8125rem] text-sage-text" id={`${id}-hint`}>
                {field.hint}
              </p>
            ) : null}
            <FieldError id={`${id}-error`} message={error} />
          </div>
        );
      })}
      <FieldError message={state.fieldErrors.locale} />
      <div className="min-w-0 space-y-3">
        <h4 className="text-[0.8125rem] font-medium">{`Body (${locale})`}</h4>
        {localization && !localization.storedBlocksReadable ? (
          <p className="border-l-2 border-error bg-surface px-4 py-3 text-sm text-error" role="alert">
            The saved body could not be read by this editor. Saving replaces it with the blocks below.
          </p>
        ) : null}
        <KnowledgeBlockEditor
          books={books}
          entityId={entityId}
          errors={state.fieldErrors}
          ideas={ideas}
          initialBlocks={localization?.bodyBlocks ?? []}
          kind={kind}
        />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{`Save ${locale} content`}</SubmitButton>
    </form>
  );
}
