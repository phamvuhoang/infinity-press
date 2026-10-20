import { describe, expect, it } from "vitest";

import { resolveIsAdmin } from "@/lib/auth/admin";

describe("resolveIsAdmin", () => {
  it("denies when the RPC call errors", () => {
    expect(resolveIsAdmin(true, { message: "connection reset" })).toBe(false);
  });

  it("denies when the RPC value is absent", () => {
    expect(resolveIsAdmin(undefined, null)).toBe(false);
  });

  it("denies when the RPC value is null", () => {
    expect(resolveIsAdmin(null, null)).toBe(false);
  });

  it("denies an unexpectedly shaped truthy value", () => {
    expect(resolveIsAdmin("true", null)).toBe(false);
  });

  it("allows only a strict boolean true with no error", () => {
    expect(resolveIsAdmin(true, null)).toBe(true);
  });
});
