import { describe, expect, it } from "vitest";

import { getSafeRedirect } from "@/lib/auth/redirect";

describe("getSafeRedirect", () => {
  it.each([
    ["/vi/library?tab=recent", "/vi/library?tab=recent"],
    ["/en", "/en"],
    ["/admin/books/new", "/admin/books/new"],
    ["/internal/en/update-password", "/internal/en/update-password"],
    ["/en/../admin", "/admin"],
  ])("keeps the application destination %s", (value, expected) => {
    expect(getSafeRedirect(value, "/vi/library")).toBe(expected);
  });

  it.each([
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/\t/evil.test",
    "account",
    "/account",
    "/vib",
    "/administrator",
    "/vi/../sign-up",
    "/internal/ja/sign-in",
    "",
  ])("rejects %j", (value) => {
    expect(getSafeRedirect(value, "/en/library")).toBe("/en/library");
  });

  it("uses the fallback when no destination is given", () => {
    expect(getSafeRedirect(null, "/en/account")).toBe("/en/account");
  });
});
