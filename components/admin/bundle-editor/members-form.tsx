"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { AdminBundleMemberDTO } from "@/lib/data/bundles";

export type BundleBookOption = { id: string; title: string; published: boolean };

// Reordering is done with explicit Move up / Move down buttons rather than drag-and-drop: a
// pointer gesture is not reachable by keyboard, and the order is the thing being edited here.
// The submitted list IS the order - admin_set_bundle_members numbers it with `with ordinality` -
// so the form posts every member id on every save, not a per-row position.
//
// Reachable is not the same as usable, so three things hold this together for a screen-reader or
// keyboard-only operator: every button's accessible name says WHICH book it moves, focus follows
// the row that moved (a button that becomes disabled at the boundary would otherwise drop focus to
// the document body after every move), and a live region announces the new position.
export function BundleMembersForm({
  action,
  books,
  members,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  books: BundleBookOption[];
  members: AdminBundleMemberDTO[];
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const [ids, setIds] = useState(() => members.map((member) => member.bookId));
  const [candidate, setCandidate] = useState("");
  const [announcement, setAnnouncement] = useState("");
  // A ref, not state: this is a one-shot instruction to the DOM after the reorder renders, and
  // clearing it from state inside the effect would be a cascading render.
  const pendingFocus = useRef<string | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement | null>());
  const errorId = "bundle-members-error";

  const known = new Map<string, BundleBookOption>([
    ...members.map((member): [string, BundleBookOption] => [
      member.bookId,
      { id: member.bookId, title: member.title, published: member.published },
    ]),
    ...books.map((book): [string, BundleBookOption] => [book.id, book]),
  ]);
  const titleOf = (id: string) => known.get(id)?.title ?? "Unknown book";
  const available = books.filter((book) => !ids.includes(book.id));

  // Focus is restored after the re-render that the move caused, because the button to focus may be
  // the one that just became disabled - in which case the other direction's button takes it.
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
    // At the top, "Move up" is about to be disabled, so hand focus to "Move down", and vice versa.
    const atBoundary = target === 0 || target === ids.length - 1;
    const direction = offset === -1 ? "up" : "down";
    const opposite = offset === -1 ? "down" : "up";
    pendingFocus.current = `${id}:${atBoundary ? opposite : direction}`;
    setAnnouncement(`Moved ${titleOf(id)} to position ${target + 1} of ${ids.length}.`);
  }

  function remove(id: string) {
    setIds((current) => current.filter((value) => value !== id));
    setAnnouncement(`Removed ${titleOf(id)} from the bundle.`);
  }

  return (
    <form action={formAction} className="space-y-5">
      {ids.map((id) => (
        <input key={id} name="bookIds" type="hidden" value={id} />
      ))}
      {ids.length === 0 ? <p className="text-sm text-sage-text">This bundle has no books yet.</p> : null}
      <ol aria-describedby={state.fieldErrors.bookIds ? errorId : undefined} className="min-w-0 border-t border-sand">
        {ids.map((id, index) => {
          const book = known.get(id);
          const title = titleOf(id);
          return (
            <li
              className="grid min-w-0 gap-2 border-b border-sand py-3 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto_auto_auto] sm:items-center"
              key={id}
            >
              <span className="text-sm text-sage-text">{index + 1}</span>
              <span className="min-w-0 break-words text-sm">
                {title}
                {book && !book.published ? <span className="ml-2 text-[0.75rem] text-sage-text">Not published</span> : null}
              </span>
              <div className="grid grid-cols-3 gap-2 sm:col-span-3 sm:contents">
                <Button
                  aria-label={`Move ${title} up`}
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
                  aria-label={`Move ${title} down`}
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
                <Button aria-label={`Remove ${title} from the bundle`} onClick={() => remove(id)} type="button" variant="ghost">
                  Remove
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only" data-testid="bundle-members-announcement" role="status">
        {announcement}
      </p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="bundle-member-candidate">Add a book to the bundle</Label>
          <NativeSelect id="bundle-member-candidate" onChange={(event) => setCandidate(event.target.value)} value={candidate}>
            <option value="">Choose a book</option>
            {available.map((book) => (
              <option key={book.id} value={book.id}>
                {book.published ? book.title : `${book.title} (not published)`}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          disabled={candidate === ""}
          onClick={() => {
            setIds((current) => [...current, candidate]);
            setAnnouncement(`Added ${titleOf(candidate)} at position ${ids.length + 1}.`);
            setCandidate("");
          }}
          type="button"
          variant="outline"
        >
          Add
        </Button>
      </div>
      <FieldError id={errorId} message={state.fieldErrors.bookIds} />
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save members</SubmitButton>
    </form>
  );
}
