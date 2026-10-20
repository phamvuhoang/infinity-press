"use client";

import { useActionState } from "react";
import { localeRegistry, locales } from "@/lib/i18n/config";

import { createArticleAction, createIdeaAction } from "@/app/admin/knowledge/actions";
import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState } from "@/lib/catalog/form";

export type KnowledgeAuthorOption = { id: string; name: string; canonicalSlug: string };

type Field = { name: string; label: string; multiline?: boolean };

// Creating an idea or article is creating its first localization - plus, for an article, its
// author. Blocks, relations, SEO, and publication are set in the editor afterwards.
export function KnowledgeCreateForm({ kind, authors = [] }: { kind: "idea" | "article"; authors?: KnowledgeAuthorOption[] }) {
  const [state, formAction] = useActionState(kind === "idea" ? createIdeaAction : createArticleAction, initialAdminFormState);
  const fields: Field[] =
    kind === "idea"
      ? [
          { name: "question", label: "Question" },
          { name: "shortAnswer", label: "Short answer", multiline: true },
          { name: "slug", label: "Slug" },
        ]
      : [
          { name: "title", label: "Title" },
          { name: "excerpt", label: "Excerpt", multiline: true },
          { name: "slug", label: "Slug" },
        ];

  const describe = (name: string) => (state.fieldErrors[name] ? `knowledge-new-${name}-error` : undefined);

  return (
    <form action={formAction} className="space-y-5">
      {kind === "article" ? (
        <div className="min-w-0 space-y-2">
          <Label htmlFor="knowledge-new-authorId">Author</Label>
          <NativeSelect
            aria-describedby={describe("authorId")}
            aria-invalid={Boolean(state.fieldErrors.authorId)}
            defaultValue=""
            id="knowledge-new-authorId"
            name="authorId"
            required
          >
            <option value="">Choose an author</option>
            {authors.map((author) => (
              <option key={author.id} value={author.id}>
                {`${author.name} (${author.canonicalSlug})`}
              </option>
            ))}
          </NativeSelect>
          <FieldError id="knowledge-new-authorId-error" message={state.fieldErrors.authorId} />
        </div>
      ) : null}
      <div className="min-w-0 space-y-2">
        <Label htmlFor="knowledge-new-locale">Locale</Label>
        <NativeSelect defaultValue="vi" id="knowledge-new-locale" name="locale">
          {locales.map((code) => (
<option key={code} value={code}>{`${localeRegistry[code].englishName} (${code})`}</option>
))}
        </NativeSelect>
        <FieldError id="knowledge-new-locale-error" message={state.fieldErrors.locale} />
      </div>
      {fields.map((field) => {
        const id = `knowledge-new-${field.name}`;
        const props = {
          "aria-describedby": describe(field.name),
          "aria-invalid": Boolean(state.fieldErrors[field.name]),
          id,
          name: field.name,
          required: true,
        };
        return (
          <div className="min-w-0 space-y-2" key={field.name}>
            <Label htmlFor={id}>{field.label}</Label>
            {field.multiline ? <Textarea {...props} rows={3} /> : <Input {...props} />}
            <FieldError id={`${id}-error`} message={state.fieldErrors[field.name]} />
          </div>
        );
      })}
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Creating…">{kind === "idea" ? "Create idea" : "Create article"}</SubmitButton>
    </form>
  );
}
