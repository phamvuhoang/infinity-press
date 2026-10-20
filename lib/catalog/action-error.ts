// Stable codes a Get or Buy form action puts in `?action-error=` on the book page (S3 spec 5.1, 5.2).
// The page maps each code to dictionary copy, so no server error text reaches the reader.
export const BOOK_ACTION_ERROR_CODES = [
  "email-not-verified",
  "no-free-offer",
  "payments-unavailable",
  "not-purchasable",
  "currency-unavailable",
  "choose-edition",
  "price-changed",
  "unexpected",
] as const;

export type BookActionErrorCode = (typeof BOOK_ACTION_ERROR_CODES)[number];

export function parseBookActionError(value: string | string[] | undefined): BookActionErrorCode | null {
  const first = Array.isArray(value) ? value[0] : value;
  return (BOOK_ACTION_ERROR_CODES as readonly string[]).includes(first ?? "") ? (first as BookActionErrorCode) : null;
}
