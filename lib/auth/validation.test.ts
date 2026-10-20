import { describe, expect, it } from "vitest";

import { readCredentials, readPasswordUpdate } from "@/lib/auth/validation";

function form(values: Record<string, string>) {
  const data = new FormData();
  Object.entries(values).forEach(([key, value]) => data.set(key, value));
  return data;
}

describe("readCredentials", () => {
  it("normalizes a valid email", () => {
    expect(
      readCredentials(
        form({ email: " Reader@Example.com ", password: "bookcase" }),
      ),
    ).toEqual({
      ok: true,
      data: { email: "reader@example.com", password: "bookcase" },
    });
  });

  it("rejects a missing email", () => {
    expect(readCredentials(form({ password: "bookcase" }))).toEqual({
      ok: false,
      error: "Enter a valid email address.",
    });
  });

  it("rejects a short password", () => {
    expect(
      readCredentials(form({ email: "reader@example.com", password: "short" })),
    ).toEqual({
      ok: false,
      error: "Password must contain at least 8 characters.",
    });
  });
});

describe("readPasswordUpdate", () => {
  it("rejects a short new password", () => {
    expect(
      readPasswordUpdate(form({ password: "short", confirmPassword: "short" })),
    ).toEqual({
      ok: false,
      error: "Password must contain at least 8 characters.",
    });
  });

  it("rejects passwords that do not match", () => {
    expect(
      readPasswordUpdate(
        form({ password: "bookcase", confirmPassword: "bookshelf" }),
      ),
    ).toEqual({
      ok: false,
      error: "Passwords do not match.",
    });
  });
});
