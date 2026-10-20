"use client";

import { useActionState } from "react";

import { createBookAction, type CreateBookFormState } from "@/app/admin/books/actions";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const initialFormState: CreateBookFormState = {
  fieldErrors: {},
  formError: null,
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-[0.8125rem] text-error" role="alert">
      {message}
    </p>
  );
}

// The one-book admin catalog workflow's form. Locale (the localization's UI
// language) and language (the book's own language) are separate selects on
// purpose - the golden-path plan requires the two stay independent, e.g. a
// Vietnamese-locale page describing an English-language book.
export function BookForm({ authorOptions }: { authorOptions: { id: string; name: string; canonicalSlug: string }[] }) {
  const [state, formAction] = useActionState(createBookAction, initialFormState);

  return (
    <form action={formAction} className="space-y-6">
      {state.formError ? (
        <p className="text-[0.8125rem] text-error" role="alert">
          {state.formError}
        </p>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="canonicalKey">Canonical key</Label>
        <Input id="canonicalKey" name="canonicalKey" placeholder="the-golden-book" required />
        <FieldError message={state.fieldErrors.canonicalKey} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="authorId">Existing author (optional)</Label>
        <NativeSelect defaultValue="" id="authorId" name="authorId">
          <option value="">Create a new author</option>
          {authorOptions.map((author) => (
            <option key={author.id} value={author.id}>
              {author.name} ({author.canonicalSlug})
            </option>
          ))}
        </NativeSelect>
        <FieldError message={state.fieldErrors.authorId} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="authorName">Author name</Label>
        <Input id="authorName" name="authorName" placeholder="Jane Austen" />
        <p className="text-[0.8125rem] text-sage-text">
          Choose an existing author above, or leave it blank and enter a new name.
        </p>
        <FieldError message={state.fieldErrors.authorName} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="locale-trigger">Locale</Label>
          <Select defaultValue="vi" name="locale">
            <SelectTrigger className="w-full" id="locale-trigger">
              <SelectValue placeholder="Select a locale" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vi">Vietnamese (vi)</SelectItem>
              <SelectItem value="en">English (en)</SelectItem>
            </SelectContent>
          </Select>
          <FieldError message={state.fieldErrors.locale} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="language-trigger">Book language</Label>
          <Select defaultValue="en" name="language">
            <SelectTrigger className="w-full" id="language-trigger">
              <SelectValue placeholder="Select the book's language" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vi">Vietnamese (vi)</SelectItem>
              <SelectItem value="en">English (en)</SelectItem>
            </SelectContent>
          </Select>
          <FieldError message={state.fieldErrors.language} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required />
        <FieldError message={state.fieldErrors.title} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="slug">Slug</Label>
        <Input id="slug" name="slug" placeholder="cuon-sach-vang" required />
        <FieldError message={state.fieldErrors.slug} />
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="market">Market</Label>
          <Input id="market" maxLength={2} name="market" placeholder="VN" required />
          <FieldError message={state.fieldErrors.market} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="currency">Currency</Label>
          <Input id="currency" maxLength={3} name="currency" placeholder="VND" required />
          <FieldError message={state.fieldErrors.currency} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="priceMinor">Price (minor units)</Label>
          <Input id="priceMinor" min={0} name="priceMinor" required type="number" />
          <FieldError message={state.fieldErrors.priceMinor} />
        </div>
      </div>

      <SubmitButton pendingLabel="Creating…">Create book</SubmitButton>
    </form>
  );
}
