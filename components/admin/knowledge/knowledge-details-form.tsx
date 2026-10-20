"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import type { KnowledgeAuthorOption } from "@/components/admin/knowledge/knowledge-create-form";
import { SubmitButton } from "@/components/auth/submit-button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

// An article's only editable unlocalized field is its author. Status changes only through
// publish and unpublish, and published_at is set by the first publish.
export function KnowledgeArticleDetailsForm({
  action,
  authors,
  authorId,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  authors: KnowledgeAuthorOption[];
  authorId: string;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} className="min-w-0 space-y-5" onReset={(event) => event.preventDefault()}>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="knowledge-authorId">Author</Label>
        <NativeSelect
          aria-describedby={state.fieldErrors.authorId ? "knowledge-authorId-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.authorId)}
          defaultValue={authorId}
          id="knowledge-authorId"
          name="authorId"
        >
          {authors.map((author) => (
            <option key={author.id} value={author.id}>
              {`${author.name} (${author.canonicalSlug})`}
            </option>
          ))}
        </NativeSelect>
        <FieldError id="knowledge-authorId-error" message={state.fieldErrors.authorId} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save details</SubmitButton>
    </form>
  );
}
