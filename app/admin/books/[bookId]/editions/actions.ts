"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import {
  fieldErrorsFrom,
  readBoolean,
  parseContributors,
  readInteger,
  readOptionalInteger,
  readOptionalText,
  readText,
  type AdminFormState,
} from "@/lib/catalog/form";
import { revalidateBookAdmin } from "@/lib/catalog/revalidate";
import { createEditionSchema, createOfferSchema, editionReviewSchema, editionSchema, provenanceSchema } from "@/lib/catalog/schemas";
import {
  createEdition,
  createOffer,
  DuplicateEditionError,
  EditionIdentityLockedError,
  EditionNotFoundError,
  getAdminEdition,
  ProvenanceIncompleteError,
  SampleNotFreeError,
  saveEditionProvenance,
  setDefaultEdition,
  setDefaultOffer,
  setEditionReview,
  setSampleFull,
  UnknownLanguageError,
  updateEdition,
} from "@/lib/data/admin-editions";
import { computeAlignmentsForBook } from "@/lib/data/alignments";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export of a "use server" module must be an async function. Each action calls
// requireAdmin() first, names its edition explicitly, never returns raw database text, and
// revalidates the pages that show the change.

const saved = (): AdminFormState => ({ fieldErrors: {}, formError: null, savedAt: Date.now() });
const invalid = (error: Parameters<typeof fieldErrorsFrom>[0]): AdminFormState => ({
  fieldErrors: fieldErrorsFrom(error),
  formError: null,
  savedAt: null,
});

function knownFailure(error: unknown): AdminFormState {
  if (error instanceof DuplicateEditionError) return { fieldErrors: { editionNumber: error.message }, formError: null, savedAt: null };
  if (error instanceof UnknownLanguageError || error instanceof EditionIdentityLockedError) {
    return { fieldErrors: { languageCode: error.message }, formError: null, savedAt: null };
  }
  if (error instanceof ProvenanceIncompleteError) return { fieldErrors: {}, formError: error.message, savedAt: null };
  if (error instanceof EditionNotFoundError || error instanceof SampleNotFreeError) {
    return { fieldErrors: {}, formError: error.message, savedAt: null };
  }
  return { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null };
}

function revalidateEdition(bookId: string, editionId: string) {
  revalidatePath(`/admin/books/${bookId}/editions/${editionId}`);
  revalidateBookAdmin(bookId);
}

export async function createEditionAction(bookId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = createEditionSchema.safeParse({
    languageCode: readText(formData, "languageCode"),
    editionNumber: readOptionalInteger(formData, "editionNumber"),
  });
  if (!parsed.success) return invalid(parsed.error);

  let editionId: string;
  try {
    ({ editionId } = await createEdition(bookId, parsed.data));
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  redirect(`/admin/books/${bookId}/editions/${editionId}`);
}

export async function updateEditionAction(
  bookId: string,
  editionId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}/editions/${editionId}` });
  const parsed = editionSchema.safeParse({
    languageCode: readText(formData, "languageCode"),
    isbn: readOptionalText(formData, "isbn"),
    editionNumber: readInteger(formData, "editionNumber"),
    publicationDate: readOptionalText(formData, "publicationDate"),
    introduction: readOptionalText(formData, "introduction"),
    contributors: parseContributors(readText(formData, "contributors")),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateEdition(editionId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateEdition(bookId, editionId);
  return saved();
}

export async function createOfferAction(
  bookId: string,
  editionId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}/editions/${editionId}` });
  // A blank price is "missing", not 0: free is an explicit 0 (see createOfferSchema).
  const parsed = createOfferSchema.safeParse({
    marketCode: readText(formData, "marketCode"),
    currency: readText(formData, "currency"),
    priceMinor: readInteger(formData, "priceMinor"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await createOffer(editionId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateEdition(bookId, editionId);
  return saved();
}

export async function setDefaultEditionAction(
  bookId: string,
  editionId: string,
  languageCode: string,
  _previous: AdminFormState, // eslint-disable-line @typescript-eslint/no-unused-vars -- form action signature
  _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars -- form action signature
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}/editions/${editionId}` });
  try {
    await setDefaultEdition(bookId, languageCode, editionId);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateEdition(bookId, editionId);
  return saved();
}

export async function setDefaultOfferAction(
  bookId: string,
  editionId: string,
  offerId: string,
  _previous: AdminFormState, // eslint-disable-line @typescript-eslint/no-unused-vars -- form action signature
  _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars -- form action signature
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}/editions/${editionId}` });
  try {
    await setDefaultOffer(editionId, offerId);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateEdition(bookId, editionId);
  return saved();
}

export async function saveProvenanceAction(
  bookId: string,
  editionId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}/editions/${editionId}` });
  const parsed = provenanceSchema.safeParse({
    textSourceNote: readOptionalText(formData, "textSourceNote"),
    translationSource: readOptionalText(formData, "translationSource"),
    rightsNote: readOptionalText(formData, "rightsNote"),
    territoryNote: readOptionalText(formData, "territoryNote"),
    textKind: readOptionalText(formData, "textKind"),
    reviewScope: readOptionalText(formData, "reviewScope") ?? "none",
    publicVersionNote: readOptionalText(formData, "publicVersionNote"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await saveEditionProvenance(editionId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateEdition(bookId, editionId);
  return saved();
}

export async function setReviewAction(
  bookId: string,
  editionId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}/editions/${editionId}` });
  const parsed = editionReviewSchema.safeParse({ state: readText(formData, "state"), note: readOptionalText(formData, "note") });
  if (!parsed.success) return invalid(parsed.error);
  // A block is a decision against publishing; saying nothing about why is not one.
  if (parsed.data.state === "blocked" && !parsed.data.note) {
    return { fieldErrors: { note: "Say why this edition is blocked." }, formError: null, savedAt: null };
  }

  try {
    await setEditionReview(editionId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateEdition(bookId, editionId);
  return saved();
}

// The whole edition as a free sample. admin_set_sample_full is the one authority on "free": it
// refuses a paid edition (22023, reported here as a form error) and always allows closing.
export async function setSampleFullAction(
  bookId: string,
  editionId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}/editions/${editionId}` });
  const full = readBoolean(formData, "full");
  // The publication comes from the edition on the server, never from the form.
  const edition = await getAdminEdition(bookId, editionId);
  if (!edition.activePublicationId) {
    return { fieldErrors: {}, formError: "No EPUB version is live for this edition yet.", savedAt: null };
  }

  try {
    await setSampleFull(edition.activePublicationId, full);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateEdition(bookId, editionId);
  return saved();
}

// Recomputes passage alignment for every pair of this work's live editions. Automatic, like the run
// after a publish: the admin only asks for it again, never edits a pairing.
export async function recomputeAlignmentAction(
  bookId: string,
  editionId: string,
  _previous: AdminFormState, // eslint-disable-line @typescript-eslint/no-unused-vars -- form action signature
  _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars -- form action signature
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}/editions/${editionId}` });
  try {
    await computeAlignmentsForBook(bookId);
  } catch (error) {
    console.error("Recompute alignment failed.", { bookId, requestId: getRequestId(await headers()), error: String(error) });
    return { fieldErrors: {}, formError: "Alignment could not be recomputed. Try again.", savedAt: null };
  }
  revalidateEdition(bookId, editionId);
  return saved();
}
