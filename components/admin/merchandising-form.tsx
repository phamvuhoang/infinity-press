"use client";

import { useActionState, useState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
type BookOption = { id: string; title: string };

export function FeaturedBookForm({
  action,
  books,
  featuredBookId,
}: {
  action: FormAction;
  books: BookOption[];
  featuredBookId: string | null;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const [bookId, setBookId] = useState(featuredBookId ?? "");
  const errorId = "featured-book-error";

  return (
    <form action={formAction} className="space-y-4" onReset={(event) => event.preventDefault()}>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="featured-book">Featured book</Label>
        <NativeSelect
          aria-describedby={state.fieldErrors.bookIds ? errorId : undefined}
          aria-invalid={Boolean(state.fieldErrors.bookIds)}
          id="featured-book"
          name="bookIds"
          onChange={(event) => setBookId(event.target.value)}
          value={bookId}
        >
          <option value="">No featured book</option>
          {books.map((book) => (
            <option key={book.id} value={book.id}>
              {book.title}
            </option>
          ))}
        </NativeSelect>
        <FieldError id={errorId} message={state.fieldErrors.bookIds} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save featured book</SubmitButton>
    </form>
  );
}

export function ShelfForm({
  action,
  books,
  shelfBookIds,
}: {
  action: FormAction;
  books: BookOption[];
  shelfBookIds: string[];
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const [ids, setIds] = useState(shelfBookIds);
  const [candidate, setCandidate] = useState("");
  const titleFor = (id: string) => books.find((book) => book.id === id)?.title ?? "Unknown book";
  const available = books.filter((book) => !ids.includes(book.id));
  const errorId = "home-shelf-error";

  function move(index: number, offset: -1 | 1) {
    setIds((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + offset, 0, item);
      return next;
    });
  }

  return (
    <form action={formAction} className="space-y-5">
      {ids.map((id) => (
        <input key={id} name="bookIds" type="hidden" value={id} />
      ))}
      {ids.length === 0 ? <p className="text-sm text-sage-text">The shelf is empty.</p> : null}
      <ol aria-describedby={state.fieldErrors.bookIds ? errorId : undefined} className="min-w-0 border-t border-sand">
        {ids.map((id, index) => (
          <li className="grid min-w-0 gap-2 border-b border-sand py-3 sm:grid-cols-[1.75rem_minmax(0,1fr)_auto_auto_auto] sm:items-center" key={id}>
            <span className="text-sm text-sage-text">{index + 1}</span>
            <span className="min-w-0 break-words text-sm">{titleFor(id)}</span>
            <div className="grid grid-cols-3 gap-2 sm:col-span-3 sm:contents">
              <Button disabled={index === 0} onClick={() => move(index, -1)} type="button" variant="ghost">
                Move up
              </Button>
              <Button disabled={index === ids.length - 1} onClick={() => move(index, 1)} type="button" variant="ghost">
                Move down
              </Button>
              <Button onClick={() => setIds((current) => current.filter((value) => value !== id))} type="button" variant="ghost">
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="shelf-candidate">Add a book to the shelf</Label>
          <NativeSelect id="shelf-candidate" onChange={(event) => setCandidate(event.target.value)} value={candidate}>
            <option value="">Choose a book</option>
            {available.map((book) => (
              <option key={book.id} value={book.id}>
                {book.title}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          disabled={candidate === ""}
          onClick={() => {
            setIds((current) => [...current, candidate]);
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
      <SubmitButton pendingLabel="Saving…">Save shelf</SubmitButton>
    </form>
  );
}
