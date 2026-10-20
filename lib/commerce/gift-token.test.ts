// @vitest-environment node
import { describe, expect, it } from "vitest";

import { GIFT_TOKEN_BYTES, generateGiftToken, hashGiftToken } from "@/lib/commerce/gift-token";

// A fixed byte source makes the generator deterministic: the production default is
// crypto.getRandomValues, which cannot be asserted against a literal.
function fixedBytes(fill: (index: number) => number) {
  return (bytes: Uint8Array) => {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = fill(index);
    return bytes;
  };
}

describe("generateGiftToken", () => {
  it("asks its byte source for exactly 32 bytes", () => {
    let requested = -1;
    generateGiftToken((bytes) => {
      requested = bytes.length;
      return bytes;
    });

    expect(requested).toBe(32);
    expect(GIFT_TOKEN_BYTES).toBe(32);
  });

  it("encodes 32 bytes as a 43-character base64url token", () => {
    const token = generateGiftToken(fixedBytes((index) => index));

    expect(token).toHaveLength(43);
    expect(token).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  });

  it("stays URL-safe and unpadded for bytes that would otherwise encode as + / =", () => {
    // 0xfb 0xff produce '+' and '/' in standard base64; base64url must use '-' and '_'.
    const token = generateGiftToken(fixedBytes((index) => (index % 2 === 0 ? 0xfb : 0xff)));

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).toContain("-");
    expect(token).toContain("_");
  });

  it("produces a different token for a different byte source", () => {
    const first = generateGiftToken(fixedBytes(() => 0));
    const second = generateGiftToken(fixedBytes(() => 1));

    expect(first).not.toBe(second);
  });

  it("uses real randomness by default", () => {
    expect(generateGiftToken()).not.toBe(generateGiftToken());
    expect(generateGiftToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("hashGiftToken", () => {
  it("returns the lower-case SHA-256 hex digest of the token", async () => {
    // The published SHA-256 of the ASCII string "abc".
    await expect(hashGiftToken("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is stable across calls and 64 lower-case hex characters wide", async () => {
    const token = generateGiftToken(fixedBytes((index) => index));
    const first = await hashGiftToken(token);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await expect(hashGiftToken(token)).resolves.toBe(first);
  });

  it("hashes different tokens differently", async () => {
    const [first, second] = await Promise.all([
      hashGiftToken(generateGiftToken(fixedBytes(() => 0))),
      hashGiftToken(generateGiftToken(fixedBytes(() => 1))),
    ]);

    expect(first).not.toBe(second);
  });

  it("never returns the token itself", async () => {
    const token = generateGiftToken();

    await expect(hashGiftToken(token)).resolves.not.toContain(token);
  });
});
