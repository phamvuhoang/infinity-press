import { Buffer } from "node:buffer";

// The gift claim token (S9 spec 7.1-7.3). The token IS the authorization to claim a gift, so it is
// treated like a password: it is generated once, handed to the recipient in the claim URL, and only
// its SHA-256 hash is ever persisted on the gift row. It never appears in the `gifts` table, in an
// application log, in audit metadata, or in a value a Server Action returns.
//
// Web Crypto only - no node:crypto - so the same module runs unchanged in every runtime the app is
// deployed to. Buffer is used for base64url encoding alone, which Web Crypto does not provide.

// 32 bytes = 256 bits of entropy, which base64url encodes as 43 unpadded characters.
export const GIFT_TOKEN_BYTES = 32;

type FillRandom = (bytes: Uint8Array) => Uint8Array;

// The byte source is a parameter so tests can be deterministic; production always takes the
// default, which is the platform CSPRNG.
export function generateGiftToken(fillRandom: FillRandom = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = fillRandom(new Uint8Array(GIFT_TOKEN_BYTES));
  // base64url, not base64: the token travels in a path segment, so '+' and '/' would have to be
  // escaped and '=' padding would be lost or doubled by intermediaries.
  return Buffer.from(bytes).toString("base64url");
}

// Lower-case hex, matching what Postgres `encode(digest(...), 'hex')` produces, so a hash computed
// here and one computed by claim_gift compare as equal text.
export async function hashGiftToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
