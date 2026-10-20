import { describe, expect, it } from "vitest";

import { getSupabaseEnv } from "@/lib/supabase/env";

describe("getSupabaseEnv", () => {
  it("returns a valid public configuration", () => {
    expect(
      getSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      }),
    ).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    });
  });

  it.each(["http://127.0.0.1:54321", "http://localhost:54321"])(
    "accepts the local Supabase URL %s",
    (url) => {
      expect(
        getSupabaseEnv({
          NEXT_PUBLIC_SUPABASE_URL: url,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
        }).url,
      ).toBe(url);
    },
  );

  it("rejects a missing value", () => {
    expect(() => getSupabaseEnv({})).toThrow(
      "Supabase environment variables are missing or invalid",
    );
  });

  it.each(["http://example.supabase.co", "http://127.0.0.1.evil.test"])(
    "rejects the non-HTTPS remote project URL %s",
    (url) => {
      expect(() =>
        getSupabaseEnv({
          NEXT_PUBLIC_SUPABASE_URL: url,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
        }),
      ).toThrow("Supabase environment variables are missing or invalid");
    },
  );
});
