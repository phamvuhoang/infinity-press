"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

export type RelatedBookOption = {
  id: string;
  title: string;
  authorName: string;
  status: "draft" | "published" | "archived";
};

// The only Client Component S11 ships: the shelf that reads these pins is rendered on the server.
//
// The submitted list IS the pin order - admin_set_related_books replaces the whole set and
// renumbers it 1..N - so the form posts one hidden field per pin in visible order rather than a
// per-row position. Dragging is the fast path and Move up / Move down is the equivalent one for a
// keyboard or screen-reader operator.
//
// Reachable is not the same as usable, so three things hold that equivalence together, as they do
// in BundleMembersForm: every button's accessible name says WHICH book it moves, focus follows the
// row that moved (a button that becomes disabled at the boundary would otherwise drop focus to the
// document body after every move), and a live region announces the new position. The row a pointer
// drags carries the same name as the buttons.
//
// The relation is directed: these are the books pinned under this one. Pinning B here does not
// pin this book under B.
export function RelatedBooksPicker({
  action,
  books,
  pinnedBookIds,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  books: RelatedBookOption[];
  pinnedBookIds: string[];
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const [ids, setIds] = useState(pinnedBookIds);
  const [candidate, setCandidate] = useState("");
  const [announcement, setAnnouncement] = useState("");
  // A ref, not state: the dragged row is a transient gesture, and re-rendering on drag start would
  // interrupt the drag it started.
  const draggedIndex = useRef<number | null>(null);
  // Also a ref: a one-shot instruction to the DOM after the reorder renders, so clearing it from
  // state inside the effect would be a cascading render.
  const pendingFocus = useRef<string | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement | null>());
  const errorId = "related-books-error";

  const known = new Map(books.map((book) => [book.id, book]));
  const available = books.filter((book) => !ids.includes(book.id));
  // A draft or archived pin stays invisible on the storefront until the book is published, so the
  // status is part of every label rather than a badge an admin has to go looking for.
  const labelOf = (id: string) => {
    const book = known.get(id);
    return book ? `${book.title} — ${book.authorName} (${book.status})` : "Unknown book";
  };
  const titleOf = (id: string) => known.get(id)?.title ?? "Unknown book";
  const error =
    state.fieldErrors.relatedBookIds ?? Object.entries(state.fieldErrors).find(([key]) => key.startsWith("relatedBookIds."))?.[1];

  // Focus is restored after the re-render the move caused, because the button to focus may be the
  // one that just became disabled - in which case the other direction's button takes it.
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    controls.current.get(key)?.focus();
  }, [ids]);

  function move(from: number, to: number) {
    setIds((current) => {
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  // The pointer reorders by dropping a row; this is the same reorder pressed one step at a time,
  // and it is the only one that has to keep focus and say what happened.
  function moveBy(index: number, offset: -1 | 1) {
    const id = ids[index];
    const target = index + offset;
    move(index, target);
    // At the top, "Move up" is about to be disabled, so hand focus to "Move down", and vice versa.
    const atBoundary = target === 0 || target === ids.length - 1;
    const direction = offset === -1 ? "up" : "down";
    const opposite = offset === -1 ? "down" : "up";
    pendingFocus.current = `${id}:${atBoundary ? opposite : direction}`;
    setAnnouncement(`Moved ${titleOf(id)} to position ${target + 1} of ${ids.length}.`);
  }

  return (
    <form action={formAction} className="space-y-5">
      {ids.map((id) => (
        <input key={id} name="relatedBookIds" type="hidden" value={id} />
      ))}
      {ids.length === 0 ? <p className="text-sm text-sage-text">No books are pinned to this one yet.</p> : null}
      <ol aria-describedby={error ? errorId : undefined} className="min-w-0 border-t border-sand">
        {ids.map((id, index) => {
          const title = titleOf(id);
          return (
            <li
              aria-label={`${labelOf(id)}, pinned at position ${index + 1} of ${ids.length}`}
              className="grid min-w-0 cursor-grab gap-2 border-b border-sand py-3 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto_auto_auto] sm:items-center"
              draggable
              key={id}
              onDragOver={(event) => event.preventDefault()}
              onDragStart={(event) => {
                draggedIndex.current = index;
                // Firefox starts no drag at all unless the dragstart handler puts something on the
                // dataTransfer. The payload itself is unused - the reordering reads draggedIndex -
                // but without this line the whole list is drag-dead in Firefox.
                event.dataTransfer?.setData("text/plain", id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = draggedIndex.current;
                draggedIndex.current = null;
                if (from === null || from === index) return;
                move(from, index);
              }}
            >
              <span className="text-sm text-sage-text">{index + 1}</span>
              <span className="min-w-0 break-words text-sm">{labelOf(id)}</span>
              <div className="grid grid-cols-3 gap-2 sm:col-span-3 sm:contents">
                <Button
                  aria-label={`Move ${title} up`}
                  disabled={index === 0}
                  onClick={() => moveBy(index, -1)}
                  ref={(node: HTMLButtonElement | null) => {
                    controls.current.set(`${id}:up`, node);
                  }}
                  type="button"
                  variant="ghost"
                >
                  Move up
                </Button>
                <Button
                  aria-label={`Move ${title} down`}
                  disabled={index === ids.length - 1}
                  onClick={() => moveBy(index, 1)}
                  ref={(node: HTMLButtonElement | null) => {
                    controls.current.set(`${id}:down`, node);
                  }}
                  type="button"
                  variant="ghost"
                >
                  Move down
                </Button>
                <Button
                  aria-label={`Remove ${title} from the pinned books`}
                  onClick={() => {
                    setIds((current) => current.filter((value) => value !== id));
                    setAnnouncement(`Removed ${title} from the pinned books.`);
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
      <p aria-live="polite" className="sr-only" data-testid="related-books-announcement" role="status">
        {announcement}
      </p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="related-books-candidate">Pin another book</Label>
          <NativeSelect id="related-books-candidate" onChange={(event) => setCandidate(event.target.value)} value={candidate}>
            <option value="">Choose a book</option>
            {available.map((book) => (
              <option key={book.id} value={book.id}>
                {labelOf(book.id)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          disabled={candidate === ""}
          onClick={() => {
            setIds((current) => [...current, candidate]);
            setAnnouncement(`Pinned ${titleOf(candidate)} at position ${ids.length + 1}.`);
            setCandidate("");
          }}
          type="button"
          variant="outline"
        >
          Add book
        </Button>
      </div>
      <FieldError id={errorId} message={error} />
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save editorial pins</SubmitButton>
    </form>
  );
}
