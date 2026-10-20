import { describe, expect, it } from "vitest";

import { parseBookActionError } from "@/lib/catalog/action-error";

describe("parseBookActionError", () => {
  it.each(["email-not-verified", "no-free-offer", "payments-unavailable", "not-purchasable", "unexpected"])(
    "accepts %s",
    (code) => {
      expect(parseBookActionError(code)).toBe(code);
    },
  );

  it.each([undefined, "", "<script>", "invalid-locale"])("ignores %j", (value) => {
    expect(parseBookActionError(value)).toBeNull();
  });

  it("uses the first value of a repeated parameter", () => {
    expect(parseBookActionError(["not-purchasable", "unexpected"])).toBe("not-purchasable");
  });
});
