import { describe, expect, it } from "vitest";

import { getPasswordRecoveryOutcome } from "@/lib/auth/password-recovery";

describe("getPasswordRecoveryOutcome", () => {
  it("reports a sent link when Supabase accepts the request", () => {
    expect(getPasswordRecoveryOutcome(null)).toBe("sent");
  });

  it.each(["user_not_found", "over_email_send_rate_limit"])(
    "does not disclose account existence through %s",
    (code) => {
      expect(getPasswordRecoveryOutcome({ code })).toBe("sent");
    },
  );

  it.each(["unexpected_failure", undefined])("reports a delivery failure for %j", (code) => {
    expect(getPasswordRecoveryOutcome({ code })).toBe("failed");
  });
});
