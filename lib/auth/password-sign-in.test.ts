import { describe, expect, it } from "vitest";

import { getPasswordSignInRoutes } from "@/lib/auth/password-sign-in";

describe("password sign-in routes", () => {
  it("restores a localized protected destination after sign-in", () => {
    expect(getPasswordSignInRoutes("vi", "/vi/library?tab=recent").destination).toBe(
      "/vi/library?tab=recent",
    );
  });

  it("restores an admin destination after sign-in", () => {
    expect(getPasswordSignInRoutes("en", "/admin").destination).toBe("/admin");
  });

  it("returns credential errors to the internal password form", () => {
    expect(
      getPasswordSignInRoutes("en", "/en/account").errorPath("credentials"),
    ).toBe("/internal/en/sign-in?next=%2Fen%2Faccount&error=credentials");
  });

  it("falls back to the selected locale when the destination is not allowed", () => {
    expect(getPasswordSignInRoutes("en", "/account").destination).toBe("/en/account");
  });
});
