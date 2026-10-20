import { z } from "zod";

// The gift half of the checkout form (S9 spec 7.1-7.2). Two fields, and the normalization that
// makes them match the database: `gifts.recipient_email` is stored lower-case under a CHECK
// constraint, and `gifts.message` is at most 500 characters or absent entirely.
//
// This module reads nothing and decides nothing about eligibility - it is a shape and a
// normalization, the way lib/commerce/coupon.ts is arithmetic and a code format.

export const GIFT_MESSAGE_MAX_LENGTH = 500;
// gifts.recipient_email is CHECKed at 3-320 characters. Bounding it here too means an over-long
// address comes back as a field error on the form rather than as a raw 23514 from the database.
export const GIFT_RECIPIENT_EMAIL_MAX_LENGTH = 320;

export const giftCheckoutSchema = z.object({
  // Trimmed and lower-cased BEFORE validation, so an address typed with stray spaces or in mixed
  // case is accepted and stored in exactly the normalized form the CHECK constraint requires.
  recipientEmail: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(
      z
        .email({ error: "Enter a valid recipient email address." })
        .max(GIFT_RECIPIENT_EMAIL_MAX_LENGTH, `Use an address of ${GIFT_RECIPIENT_EMAIL_MAX_LENGTH} characters or fewer.`),
    ),
  // Optional: a gift with no note is ordinary. The length is measured after trimming, so trailing
  // whitespace never pushes an otherwise-valid message over the limit, and a message that is only
  // whitespace is the same as no message at all.
  message: z
    .string()
    .trim()
    .max(GIFT_MESSAGE_MAX_LENGTH, `Keep the message to ${GIFT_MESSAGE_MAX_LENGTH} characters or fewer.`)
    .default("")
    .transform((value) => (value.length === 0 ? null : value)),
});

export type GiftCheckoutInput = z.infer<typeof giftCheckoutSchema>;
