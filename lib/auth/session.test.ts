import { describe, expect, it } from "vitest";

import { buildSignInRedirect, decideAccess } from "@/lib/auth/session";

describe("decideAccess", () => {
  it("requires sign-in when no user exists", () => {
    expect(decideAccess(null, "reader")).toBe("sign-in");
  });

  it("requires sign-in for admin access when no user exists", () => {
    expect(decideAccess(null, "admin")).toBe("sign-in");
  });

  it("forbids a reader from admin access", () => {
    expect(decideAccess({ role: "reader" }, "admin")).toBe("forbidden");
  });

  it("allows a reader at the reader level", () => {
    expect(decideAccess({ role: "reader" }, "reader")).toBe("allow");
  });

  it("allows an admin", () => {
    expect(decideAccess({ role: "admin" }, "admin")).toBe("allow");
  });
});

describe("buildSignInRedirect", () => {
  it("routes an internal destination through the internal sign-in page", () => {
    expect(buildSignInRedirect("en", "/internal/en/update-password")).toBe(
      "/internal/en/sign-in?next=%2Finternal%2Fen%2Fupdate-password",
    );
  });

  it("routes any other destination through the public sign-in page", () => {
    expect(buildSignInRedirect("en", "/en/library")).toBe("/en/sign-in?next=%2Fen%2Flibrary");
  });

  it("omits the query string when there is no destination", () => {
    expect(buildSignInRedirect("vi")).toBe("/vi/sign-in");
  });
});
