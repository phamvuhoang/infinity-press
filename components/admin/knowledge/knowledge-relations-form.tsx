"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import type { KnowledgeBookOption, KnowledgeIdeaOption } from "@/components/admin/knowledge/knowledge-block-editor";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState, type FieldErrors } from "@/lib/catalog/form";

type Option = { id: string; label: string };

function errorFor(errors: FieldErrors, name: string): string | undefined {
  return errors[name] ?? Object.entries(errors).find(([key]) => key.startsWith(`${name}.`))?.[1];
}

// An editorially ordered list of ids. The posted hidden inputs ARE the order - the relation RPC
// numbers them - so reordering means posting the whole list again. Move up / Move down keep it
// keyboard-reachable, and focus follows the moved row like the bundle members editor.
function OrderedPicker({
  name,
  legend,
  noun,
  options,
  initial,
  error,
}: {
  name: string;
  legend: string;
  noun: string;
  options: Option[];
  initial: string[];
  error?: string;
}) {
  const [ids, setIds] = useState(initial);
  const [candidate, setCandidate] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const pendingFocus = useRef<string | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement | null>());
  const labels = new Map(options.map((option) => [option.id, option.label]));
  const labelOf = (id: string) => labels.get(id) ?? `Unknown ${noun}`;
  const available = options.filter((option) => !ids.includes(option.id));
  const withArticle = `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;
  const errorId = `knowledge-${name}-error`;
  const selectId = `knowledge-${name}-candidate`;

  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    controls.current.get(key)?.focus();
  }, [ids]);

  function move(index: number, offset: -1 | 1) {
    const id = ids[index];
    const target = index + offset;
    setIds((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    const atBoundary = target === 0 || target === ids.length - 1;
    pendingFocus.current = `${id}:${atBoundary ? (offset === -1 ? "down" : "up") : offset === -1 ? "up" : "down"}`;
    setAnnouncement(`Moved ${labelOf(id)} to position ${target + 1} of ${ids.length}.`);
  }

  return (
    <fieldset aria-describedby={error ? errorId : undefined} className="min-w-0 space-y-3">
      <legend className="mb-2 text-[0.8125rem] font-medium">{legend}</legend>
      {ids.map((id) => (
        <input key={id} name={name} type="hidden" value={id} />
      ))}
      {ids.length === 0 ? <p className="text-sm text-sage-text">{`No ${noun}s yet.`}</p> : null}
      <ol className="min-w-0 border-t border-sand">
        {ids.map((id, index) => {
          const label = labelOf(id);
          return (
            <li
              aria-label={label}
              className="grid min-w-0 gap-2 border-b border-sand py-3 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto_auto_auto] sm:items-center"
              key={id}
            >
              <span className="text-sm text-sage-text">{index + 1}</span>
              <span className="min-w-0 break-words text-sm">{label}</span>
              <div className="grid grid-cols-3 gap-2 sm:col-span-3 sm:contents">
                <Button
                  aria-label={`Move ${label} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  ref={(node: HTMLButtonElement | null) => {
                    controls.current.set(`${id}:up`, node);
                  }}
                  type="button"
                  variant="ghost"
                >
                  Move up
                </Button>
                <Button
                  aria-label={`Move ${label} down`}
                  disabled={index === ids.length - 1}
                  onClick={() => move(index, 1)}
                  ref={(node: HTMLButtonElement | null) => {
                    controls.current.set(`${id}:down`, node);
                  }}
                  type="button"
                  variant="ghost"
                >
                  Move down
                </Button>
                <Button
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    setIds((current) => current.filter((value) => value !== id));
                    setAnnouncement(`Removed ${label}.`);
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
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0 space-y-2">
          <Label htmlFor={selectId}>{`Add ${withArticle}`}</Label>
          <NativeSelect id={selectId} onChange={(event) => setCandidate(event.target.value)} value={candidate}>
            <option value="">{`Choose ${withArticle}`}</option>
            {available.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          aria-label={`Add ${noun}`}
          disabled={candidate === ""}
          onClick={() => {
            setIds((current) => [...current, candidate]);
            setAnnouncement(`Added ${labelOf(candidate)} at position ${ids.length + 1}.`);
            setCandidate("");
          }}
          type="button"
          variant="outline"
        >
          Add
        </Button>
      </div>
      <FieldError id={errorId} message={error} />
    </fieldset>
  );
}

// Books and ideas are ordered; topics are a set. An idea relates to other ideas
// (`relatedIdeaIds`); an article features ideas (`ideaIds`). The page removes the idea itself from
// its own related-idea options.
export function KnowledgeRelationsForm({
  kind,
  action,
  books,
  ideas,
  topics,
  defaults,
}: {
  kind: "idea" | "article";
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  books: KnowledgeBookOption[];
  ideas: KnowledgeIdeaOption[];
  topics: { id: string; name: string }[];
  defaults: { bookIds: string[]; ideaIds: string[]; topicIds: string[] };
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const ideaField = kind === "idea" ? "relatedIdeaIds" : "ideaIds";
  const topicError = errorFor(state.fieldErrors, "topicIds");

  return (
    <form action={formAction} className="min-w-0 space-y-8" onReset={(event) => event.preventDefault()}>
      <OrderedPicker
        error={errorFor(state.fieldErrors, "bookIds")}
        initial={defaults.bookIds}
        legend={kind === "idea" ? "Related books (an idea needs at least one to publish)" : "Books"}
        name="bookIds"
        noun="book"
        options={books.map((book) => ({ id: book.id, label: book.published ? book.title : `${book.title} (not published)` }))}
      />
      <OrderedPicker
        error={errorFor(state.fieldErrors, ideaField)}
        initial={defaults.ideaIds}
        legend={kind === "idea" ? "Related ideas" : "Ideas"}
        name={ideaField}
        noun="idea"
        options={ideas.map((idea) => ({ id: idea.id, label: idea.title }))}
      />
      <fieldset aria-describedby={topicError ? "knowledge-topicIds-error" : undefined} className="min-w-0 space-y-2">
        <legend className="mb-2 text-[0.8125rem] font-medium">Topics</legend>
        {topics.length === 0 ? <p className="text-sm text-sage-text">No topics yet. Create them under Topics.</p> : null}
        <div className="grid gap-x-6 sm:grid-cols-2">
          {topics.map((topic) => (
            <label className="flex min-h-11 items-center gap-3 text-sm" key={topic.id}>
              <input
                className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                defaultChecked={defaults.topicIds.includes(topic.id)}
                name="topicIds"
                type="checkbox"
                value={topic.id}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{topic.name}</span>
            </label>
          ))}
        </div>
        <FieldError id="knowledge-topicIds-error" message={topicError} />
      </fieldset>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save relations</SubmitButton>
    </form>
  );
}
