import { describe, expect, it } from "vitest";

import { getMagicLinkOutcome, getMagicLinkRoutes } from "@/lib/auth/magic-link";

describe("getMagicLinkRoutes", () => {
  it("keeps a safe localized destination", () => {
    expect(getMagicLinkRoutes("en", "/en/read/book-1").destination).toBe("/en/read/book-1");
  });

  it("keeps an admin destination", () => {
    expect(getMagicLinkRoutes("vi", "/admin/books/new").destination).toBe("/admin/books/new");
  });

  it.each(["https://evil.test", "/account", null])(
    "falls back to the page locale library for %j",
    (next) => {
      expect(getMagicLinkRoutes("en", next).destination).toBe("/en/library");
    },
  );

  it("keeps the destination on localized error and message responses", () => {
    const routes = getMagicLinkRoutes("en", "/en/read/book-1");

    expect(routes.errorPath("email")).toBe(
      "/en/sign-in?next=%2Fen%2Fread%2Fbook-1&error=email",
    );
    expect(routes.messagePath("check-email")).toBe(
      "/en/sign-in?next=%2Fen%2Fread%2Fbook-1&message=check-email",
    );
  });
});

describe("getMagicLinkOutcome", () => {
  it("reports a delivered link when Supabase accepts the request", () => {
    expect(getMagicLinkOutcome(null)).toBe("sent");
  });

  it.each(["otp_disabled", "signup_disabled", "user_not_found"])(
    "does not disclose account existence through %s",
    (code) => {
      expect(getMagicLinkOutcome({ code })).toBe("sent");
    },
  );

  it.each(["over_email_send_rate_limit", undefined])(
    "reports a delivery failure for %j",
    (code) => {
      expect(getMagicLinkOutcome({ code })).toBe("failed");
    },
  );
});
