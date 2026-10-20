// The order reference is the bank transfer memo: a person reads it off a screen and types it into a
// banking app. The alphabet is Crockford base32 without I, L, O, and U, so a mistyped memo is far
// less likely and no code can spell an unfortunate word. Generation lives in the database, beside
// the unique constraint that makes a retry correct; this module is the shape both sides agree on.
export const ORDER_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ORDER_REFERENCE_PATTERN = /^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/;

export function isOrderReference(value: string): boolean {
  return ORDER_REFERENCE_PATTERN.test(value.trim().toUpperCase());
}
