"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { createBookSchema } from "@/lib/catalog/schemas";
import {
  createBook,
  DuplicateCanonicalKeyError,
  DuplicateSlugError,
} from "@/lib/data/books";

// Type-only: erased at compile time, so it's fine for a "use server" module to
// export it. A runtime value export (e.g. a constant initial state) is not -
// every runtime export of a "use server" file must be an async function, so
// the initial state for useActionState lives in book-form.tsx instead.
export type CreateBookFormState = {
  fieldErrors: Partial<Record<keyof typeof createBookSchema.shape, string>>;
  formError: string | null;
};

function readFormValues(formData: FormData) {
  // A Server Action is a directly invocable POST endpoint, not just a form submit handler - the
  // browser's `required` attribute on the price field (components/admin/book-form.tsx) guards
  // nothing here. Number(null) and Number("") are both 0, and priceMinor: 0 is a valid free-book
  // price (lib/catalog/schemas.ts), so a missing/blank field used to validate cleanly as $0
  // instead of being rejected. Mapping "" and null to undefined lets Zod reject it as missing.
  const priceMinorRaw = formData.get("priceMinor");
  const authorIdRaw = formData.get("authorId");
  return {
    canonicalKey: formData.get("canonicalKey"),
    authorId: authorIdRaw === null || authorIdRaw === "" ? null : authorIdRaw,
    authorName: formData.get("authorName"),
    locale: formData.get("locale"),
    language: formData.get("language"),
    title: formData.get("title"),
    slug: formData.get("slug"),
    market: formData.get("market"),
    currency: formData.get("currency"),
    priceMinor: priceMinorRaw === null || priceMinorRaw === "" ? undefined : Number(priceMinorRaw),
  };
}

// The one-book admin catalog workflow's mutation. Only ever returns validation
// errors (schema failures) or a generic message through useActionState - never
// a raw Supabase/Postgres error, per the golden-path plan's "never surface raw
// Supabase errors to the client" rule.
export async function createBookAction(
  _prevState: CreateBookFormState,
  formData: FormData,
): Promise<CreateBookFormState> {
  await requireAdmin({ next: "/admin/books/new" });

  const parsed = createBookSchema.safeParse(readFormValues(formData));
  if (!parsed.success) {
    const flattened = parsed.error.flatten().fieldErrors;
    const fieldErrors: CreateBookFormState["fieldErrors"] = {};
    for (const key of Object.keys(flattened) as (keyof typeof flattened)[]) {
      const messages = flattened[key];
      if (messages?.[0]) fieldErrors[key] = messages[0];
    }
    return { fieldErrors, formError: null };
  }

  let bookId: string;
  try {
    ({ bookId } = await createBook(parsed.data));
  } catch (error) {
    // admin_create_book reuses existing authors. Book-key and locale/slug collisions still
    // belong to their respective fields.
    if (error instanceof DuplicateCanonicalKeyError) {
      return { fieldErrors: { canonicalKey: error.message }, formError: null };
    }
    if (error instanceof DuplicateSlugError) {
      return { fieldErrors: { slug: error.message }, formError: null };
    }
    // Anything else (RPC rejection, network failure, unexpected shape) stays
    // server-side. The client only ever sees this generic message.
    return {
      fieldErrors: {},
      formError: "Something went wrong creating the book. Try again.",
    };
  }

  // `/admin/books` names no route - app/admin/ has only books/[bookId]/, books/new/, and
  // books/actions.ts - so the original call revalidated nothing. Matches the correction already
  // applied to the publications actions (app/admin/publications/[publicationId]/actions.ts:59,103):
  // revalidate the specific page that actually exists, which here is the newly created book's own
  // page, i.e. exactly the route the redirect below navigates to.
  revalidatePath(`/admin/books/${bookId}`);
  redirect(`/admin/books/${bookId}`);
}
