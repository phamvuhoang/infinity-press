import { describe, expect, it } from "vitest";

import { getAuthCallbackUrl, readAuthCallback } from "@/lib/auth/callback";

function read(query: string) {
  return readAuthCallback(new URLSearchParams(query));
}

describe("getAuthCallbackUrl", () => {
  it("builds the callback from the configured site URL", () => {
    expect(getAuthCallbackUrl("https://books.test", "en", "/en/library")).toBe(
      "https://books.test/auth/callback?next=%2Fen%2Flibrary&locale=en",
    );
  });
});

describe("readAuthCallback", () => {
  it("reads a cross-device email token for a localized destination", () => {
    expect(read("token_hash=hash-1&type=email&next=%2Fen%2Flibrary&locale=en")).toEqual({
      credential: { type: "token_hash", tokenHash: "hash-1", otpType: "email" },
      destination: "/en/library",
      errorPath: "/en/sign-in?next=%2Fen%2Flibrary&error=callback",
    });
  });

  it("reads a same-browser PKCE code for an admin destination", () => {
    expect(read("code=code-1&next=%2Fadmin&locale=en")).toEqual({
      credential: { type: "code", code: "code-1" },
      destination: "/admin",
      errorPath: "/en/sign-in?next=%2Fadmin&error=callback",
    });
  });

  it("returns failed password recovery to the internal recovery form", () => {
    expect(
      read("token_hash=hash-2&type=recovery&next=%2Finternal%2Fen%2Fupdate-password&locale=en"),
    ).toMatchObject({
      credential: { type: "token_hash", tokenHash: "hash-2", otpType: "recovery" },
      destination: "/internal/en/update-password",
      errorPath: "/internal/en/forgot-password?error=callback",
    });
  });

  it("reads the destination from an escaped redirect_to in a site URL link", () => {
    const redirectTo = encodeURIComponent(
      "http://127.0.0.1:3000/auth/callback?next=%2Fen%2Faccount&locale=en",
    );

    expect(read(`token_hash=hash-4&type=email&redirect_to=${redirectTo}`)).toMatchObject({
      credential: { type: "token_hash", tokenHash: "hash-4", otpType: "email" },
      destination: "/en/account",
      errorPath: "/en/sign-in?next=%2Fen%2Faccount&error=callback",
    });
  });

  it("reads the destination from an unescaped redirect_to in a site URL link", () => {
    expect(
      read(
        "token_hash=hash-5&type=email&redirect_to=http://127.0.0.1:3000/auth/callback?next=%2Fen%2Faccount&locale=en",
      ).destination,
    ).toBe("/en/account");
  });

  it("still signs in when Supabase falls back to the bare site URL", () => {
    expect(
      read("token_hash=hash-6&type=email&redirect_to=http%3A%2F%2F127.0.0.1%3A3000"),
    ).toMatchObject({
      credential: { type: "token_hash", tokenHash: "hash-6", otpType: "email" },
      destination: "/en/library",
    });
  });

  it("rejects an unsupported email token type", () => {
    expect(read("token_hash=hash-3&type=invite&next=%2Fen%2Flibrary").credential).toBeNull();
  });

  it("replaces an unsafe destination with the requested locale library", () => {
    expect(read("code=code-2&next=https%3A%2F%2Fevil.test&locale=en").destination).toBe(
      "/en/library",
    );
  });

  it("uses the destination locale when the locale parameter is missing", () => {
    expect(read("code=code-3&next=%2Fen%2Fread%2Fbook-1").errorPath).toBe(
      "/en/sign-in?next=%2Fen%2Fread%2Fbook-1&error=callback",
    );
  });
});
