import { describe, expect, it } from "vitest";

import { decideRouteAccess } from "@/lib/auth/route-access";

function anonymous(pathname: string, search = "") {
  return decideRouteAccess({ pathname, search, signedIn: false });
}

function signedIn(pathname: string, search = "") {
  return decideRouteAccess({ pathname, search, signedIn: true });
}

describe("decideRouteAccess", () => {
  it.each([
    ["/vi/account", "", "/vi/sign-in?next=%2Fvi%2Faccount"],
    ["/en/library", "", "/en/sign-in?next=%2Fen%2Flibrary"],
    ["/en/read/book-1", "?page=2", "/en/sign-in?next=%2Fen%2Fread%2Fbook-1%3Fpage%3D2"],
    ["/admin/books/new", "", "/vi/sign-in?next=%2Fadmin%2Fbooks%2Fnew"],
    [
      "/internal/en/update-password",
      "",
      "/internal/en/sign-in?next=%2Finternal%2Fen%2Fupdate-password",
    ],
    ["/en/checkout/order-1", "", "/en/sign-in?next=%2Fen%2Fcheckout%2Forder-1"],
    ["/vi/ask", "?book=b1", "/vi/sign-in?next=%2Fvi%2Fask%3Fbook%3Db1"],
  ])("sends an anonymous visitor from %s%s to sign in", (pathname, search, expected) => {
    expect(anonymous(pathname, search)).toBe(expected);
  });

  it.each([
    "/en",
    "/vi/accounting",
    "/vi/readers",
    "/administrator",
    "/vi/sign-in",
    "/internal/en/sign-in",
    // The sample reader is the one reading surface with no sign-in wall. Adding "read-sample" to
    // readerPages would put one in front of it, and the failure mode is silent: the page would
    // simply redirect instead of rendering.
    "/vi/read-sample/a-book",
    "/en/read-sample/a-book",
  ])("lets an anonymous visitor open %s", (pathname) => {
    expect(anonymous(pathname)).toBeNull();
  });

  it.each([
    ["/en/sign-in", "", "/en/account"],
    ["/en/sign-in", "?next=%2Fen%2Fread%2Fbook-1", "/en/read/book-1"],
    ["/en/sign-in", "?next=https%3A%2F%2Fevil.test", "/en/account"],
    ["/en/sign-in", "?next=%2Fen%2Fsign-in", "/en/account"],
    ["/internal/en/sign-in", "", "/en/account"],
    ["/internal/vi/forgot-password", "", "/vi/account"],
  ])("sends a signed-in reader away from %s%s", (pathname, search, expected) => {
    expect(signedIn(pathname, search)).toBe(expected);
  });

  it.each(["/vi/account", "/admin", "/internal/en/update-password"])(
    "lets a signed-in reader open %s",
    (pathname) => {
      expect(signedIn(pathname)).toBeNull();
    },
  );
});
